import type { AnyFn, BindableValue, DirectiveSlug, HandlerCtx, Scope } from '../types';
import { STORE_PREFIX } from './constants';
import { err } from './diagnostics';
import { parseDataSourcePath } from './parser';
import { renderCtxOf } from './render-context';
import { resolveState } from './resolve';
import type { StoreManager } from './store';

/**
 * Invokes a resolved handler with a `HandlerCtx` built from the triggering
 * event and the binding scope's render context. Returns the handler's result,
 * or `undefined` if it throws. An async handler is treated the same way: a
 * rejection is reported, and the returned promise resolves to `undefined`.
 */
export function invokeHandler(
  method: AnyFn,
  context: unknown,
  name: string,
  scope: Scope,
  el: Element,
  e: Event,
): unknown {
  const onError = (error: unknown) => {
    err(`Failed to execute '${name}()'.`, el, error);
    return undefined;
  };

  try {
    const args: HandlerCtx<Element> = {
      el,
      e,
      render: renderCtxOf(scope),
    };
    const result = method.call(context, args);

    // A rejection lands after this frame, where the catch below can't see it
    return typeof result?.then === 'function'
      ? (result as PromiseLike<unknown>).then(undefined, onError)
      : result;
  } catch (error) {
    return onError(error);
  }
}

/**
 * Resolves a one-way binding value that may target a static property or a
 * function. If the target is a function, it is invoked with a `HandlerCtx` whose
 * `e` is a synthetic CustomEvent typed `rz:${slug}`.
 *
 * Returns `undefined` when the key resolves to nothing. An absent path is a
 * valid empty state, not an error, so callers render it as empty rather than
 * preserving stale content.
 */
export function resolveBoundValue(
  raw: string,
  scope: Scope,
  storeManager: StoreManager,
  el: Element,
  slug: DirectiveSlug,
): BindableValue {
  const key = raw.trim();
  const state = resolveState<unknown>(key, scope, storeManager);

  if (typeof state === 'function') {
    const context = key.startsWith(STORE_PREFIX)
      ? storeManager.get(parseDataSourcePath(key).source)
      : scope;

    return invokeHandler(
      state as AnyFn,
      context,
      key,
      scope,
      el,
      new CustomEvent(`rz:${slug}`),
    ) as BindableValue;
  }

  return state as BindableValue;
}
