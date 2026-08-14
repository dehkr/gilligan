import { queryTargets } from '../core/attributes';
import { warn } from '../core/diagnostics';
import { dispatch } from '../dom/events';
import type {
  FetchConfigDetail,
  PushPullConfigDetail,
  PushPullResultDetail,
  RouseResponse,
} from '../types';

export const PREVENTED = Symbol('rz.prevented');

const REQUEST_CLASS = 'rouse-request';

/** In-flight request count per indicator element. */
const inFlight = new WeakMap<Element, number>();

export interface LifecycleHandle {
  settle: (result: RouseResponse) => void;
}

/** Fields every request-axis family shares, independent of its detail shapes. */
interface LifecycleBase {
  el: Element;
  root: Element;
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
        terminalDetail: (result: RouseResponse) => RouseResponse;
      }
    | {
        prefix: 'rz:push' | 'rz:pull';
        configDetail: PushPullConfigDetail;
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
  const { el, root, prefix, configDetail, terminalDetail, run } = opts;

  const configEvent = dispatch(el, `${prefix}:config`, configDetail, {
    cancelable: true,
  });

  if (configEvent.defaultPrevented) return PREVENTED;

  // Only the `:config` detail carries `url` and `method` so drop them
  const { url: _url, method: _method, ...lifecycleDetail } = configDetail;
  // Resolved after the `:config` gate so listeners can retarget `indicator`
  const indicators = resolveIndicators(el, root, configDetail.config.indicator);

  trackInFlight(indicators, 1);

  dispatch(el, `${prefix}:start`, lifecycleDetail);

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
      dispatch(el, `${prefix}:abort`, lifecycleDetail);
      return;
    }

    if (result.error) {
      dispatch(el, `${prefix}:error`, terminalDetail(result));
      return;
    }

    dispatch(el, `${prefix}:success`, terminalDetail(result));

    const trigger = result.headers?.['rouse-trigger'];
    if (trigger) {
      dispatch(el, trigger, result);
    }
  };

  try {
    return await run({ settle });
  } finally {
    trackInFlight(indicators, -1);
    dispatch(el, `${prefix}:end`, lifecycleDetail);
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

/**
 * Tracks in-flight requests per indicator element (`1` on start and `-1` on settle) so
 * overlapping requests sharing an indicator don't clear each other's request class.
 */
function trackInFlight(els: Element[], delta: 1 | -1) {
  for (const el of els) {
    const n = Math.max(0, (inFlight.get(el) ?? 0) + delta);
    inFlight.set(el, n);
    el.classList.toggle(REQUEST_CLASS, n > 0);
  }
}
