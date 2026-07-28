import { dispatch } from '../dom/events';
import type { RouseResponse } from '../types';

export const PREVENTED = Symbol('rz.prevented');

export interface LifecycleHandle {
  settle: (result: RouseResponse) => void;
}

export interface RequestLifecycleOptions {
  el: Element;
  prefix: 'rz:fetch' | 'rz:push' | 'rz:pull';
  configDetail: Record<string, unknown>;
  lifecycleDetail: Record<string, unknown>;
  terminalDetail: (result: RouseResponse) => unknown;
  run: (handle: LifecycleHandle) => Promise<RouseResponse>;
}

/**
 * Wraps a network operation in the shared request-axis lifecycle. Returns `PREVENTED`
 * if a `config` listener is canceled, otherwise the response.
 */
export async function runRequestLifecycle(
  opts: RequestLifecycleOptions,
): Promise<RouseResponse | typeof PREVENTED> {
  const { el, prefix, configDetail, lifecycleDetail, terminalDetail, run } = opts;

  const emit = (event: string, detail: unknown, options?: CustomEventInit) =>
    dispatch(el, event, detail, options);

  const configEvent = emit(`${prefix}:config`, configDetail, { cancelable: true });
  if (configEvent.defaultPrevented) {
    return PREVENTED;
  }

  el.classList.add('rz-loading');
  el.setAttribute('aria-busy', 'true');

  emit(`${prefix}:start`, lifecycleDetail);

  let settled = false;

  /**
   * Classifies the settled response into exactly one terminal request-axis event:
   * `:abort` when the request was canceled, `:error` for any other failure, `:success`
   * otherwise. Then honors a `Rouse-Trigger` header by dispatching the named event
   * with the raw response as its detail. Idempotent. Affordances clear and `:end`
   * fires even when `run` never settles.
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
    el.classList.remove('rz-loading');
    el.removeAttribute('aria-busy');
    emit(`${prefix}:end`, lifecycleDetail);
  }
}
