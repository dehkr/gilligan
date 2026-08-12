import { queryTargets } from '../core/attributes';
import { warn } from '../core/diagnostics';
import { dispatch } from '../dom/events';
import type {
  FetchConfigDetail,
  FetchLifecycleDetail,
  PushPullConfigDetail,
  PushPullLifecycleDetail,
  PushPullResultDetail,
  RouseRequest,
  RouseResponse,
} from '../types';

export const PREVENTED = Symbol('rz.prevented');

const REQUEST_CLASS = 'rouse-request';

/** Per-element ref counts, so overlapping requests don't clear each other's class. */
const inFlight = new WeakMap<Element, number>();

export interface LifecycleHandle {
  settle: (result: RouseResponse) => void;
}

/** Fields every request-axis family shares, independent of its detail shapes. */
interface LifecycleBase {
  el: Element;
  root: Element;
  /** Resolved config, read after the `:config` gate so listeners can retarget `indicator`. */
  config: RouseRequest;
  run: (handle: LifecycleHandle) => Promise<RouseResponse>;
}

/**
 * Discriminated on `prefix` so each caller's detail objects are checked against
 * the `LifecycleEventMap` entries for the family it dispatches.
 */
export type RequestLifecycleOptions = LifecycleBase &
  (
    | {
        prefix: 'rz:fetch';
        configDetail: FetchConfigDetail;
        lifecycleDetail: FetchLifecycleDetail;
        terminalDetail: (result: RouseResponse) => RouseResponse;
      }
    | {
        prefix: 'rz:push' | 'rz:pull';
        configDetail: PushPullConfigDetail;
        lifecycleDetail: PushPullLifecycleDetail;
        terminalDetail: (result: RouseResponse) => PushPullResultDetail;
      }
  );

/**
 * Wraps a network operation in the shared request-axis lifecycle. Returns `PREVENTED`
 * if a `config` listener is canceled, otherwise the response.
 */
export async function runRequestLifecycle(
  opts: RequestLifecycleOptions,
): Promise<RouseResponse | typeof PREVENTED> {
  const { el, root, prefix, config, configDetail, lifecycleDetail, terminalDetail, run } =
    opts;

  const emit = (event: string, detail: unknown, options?: CustomEventInit) =>
    dispatch(el, event, detail, options);

  const configEvent = emit(`${prefix}:config`, configDetail, { cancelable: true });
  if (configEvent.defaultPrevented) {
    return PREVENTED;
  }

  const indicators = resolveIndicators(el, root, config.indicator);
  mark(indicators);

  emit(`${prefix}:start`, lifecycleDetail);

  let settled = false;

  /**
   * Classifies the settled response into exactly one terminal request-axis event:
   *
   * - `:abort` when the request was canceled
   * - `:error` for any other failure
   * - `:success` otherwise
   *
   * Then honors a `Rouse-Trigger` header by dispatching the named event with the
   * raw response as its detail. Idempotent. Affordances clear and `:end` fires even
   * when `run` never settles.
   */
  const settle = (result: RouseResponse) => {
    if (settled) return;
    settled = true;

    if (result.error?.status === 'CANCELED') {
      emit(`${prefix}:abort`, lifecycleDetail);
      return;
    }

    if (result.error) {
      emit(`${prefix}:error`, terminalDetail(result));
      return;
    }

    emit(`${prefix}:success`, terminalDetail(result));

    const trigger = result.headers?.['rouse-trigger'];
    if (trigger) {
      emit(trigger, result);
    }
  };

  try {
    return await run({ settle });
  } finally {
    unmark(indicators);
    emit(`${prefix}:end`, lifecycleDetail);
  }
}

/**
 * Resolves which elements get the request class: the firing element by default,
 * an `indicator` selector's matches when set, or none if value is `null`.
 */
function resolveIndicators(
  el: Element,
  root: Element,
  indicator: string | null | undefined,
): Element[] {
  if (indicator === undefined) return [el];
  if (indicator === null) return [];

  const els = queryTargets(root, indicator);
  __DEV__ && !els.length && warn(`No indicator elements match '${indicator}'.`, el);
  return els;
}

/** Adds the request class on each element's first in-flight request. */
function mark(els: Element[]) {
  for (const el of els) {
    const n = (inFlight.get(el) ?? 0) + 1;
    inFlight.set(el, n);
    if (n === 1) {
      el.classList.add(REQUEST_CLASS);
    }
  }
}

/** Removes the request class once an element's last in-flight request settles. */
function unmark(els: Element[]) {
  for (const el of els) {
    const n = (inFlight.get(el) ?? 1) - 1;
    if (n > 0) {
      inFlight.set(el, n);
      continue;
    }
    inFlight.delete(el);
    el.classList.remove(REQUEST_CLASS);
  }
}
