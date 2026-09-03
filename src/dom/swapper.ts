import type { RouseApp } from '../core/app';
import {
  DEFAULT_SWAP_METHOD,
  isSwapMethod,
  SWAP_METHODS,
  type SwapMethod,
} from '../core/constants';
import { warn } from '../core/diagnostics';
import { dispatch } from '../core/dispatch';
import { rzTarget } from '../directives';
import type { RouseResponse } from '../types';

/**
 * Listens to the app root for HTML fetch responses and routes the payloads into DOM
 * targets named by `rz-target` on the originating element, or a server `Rouse-Target`
 * header.
 *
 * A programmatic fetch doesn't have an element, so it doesn't swap by default. A server-
 * named target can place the payload, or the caller can place it using `swap()`. The
 * `triggerEl` option is configurable, however, so a pre-configured element can be
 * triggered remotely.
 *
 * Error responses route only when the server names a target, since `rz-target` is
 * success-only output.
 */
export function initDomRouter(app: RouseApp, signal: AbortSignal) {
  const route = (e: Event) => {
    const { detail } = e as CustomEvent<RouseResponse>;
    const { config, data, targetOverride } = detail;
    const triggerEl = config?.triggerEl;

    // An empty response (`null`) or non-string body has nothing to swap
    if (typeof data !== 'string') return;
    // Don't route an error response unless the server provides an override
    if (e.type.includes('error') && !targetOverride) return;
    // No originating element means no destination or host for the declarative path
    if (!triggerEl && !targetOverride) return;

    const { swaps } = rzTarget.getConfig(triggerEl ?? app.root, app.root, targetOverride);

    for (const { targets, method } of swaps) {
      for (const targetEl of targets) {
        swap(data, targetEl, method, 'fetch');
      }
    }
  };

  ['success', 'error'].forEach((eventType) => {
    app.root.addEventListener(`rz:fetch:${eventType}:html`, route, { signal });
  });
}

/**
 * Swaps HTML content into a target element, replaces it, or removes it.
 *
 * Fires a cancelable `rz:dom:swap:before` event first; a listener can cancel it to
 * skip the swap, or mutate `detail.payload` to change what gets written. A `rz:dom:swap`
 * event follows. For `outerHTML` and `delete`, both events fire from the target's parent,
 * since the target itself is replaced or removed.
 *
 * @param content - The HTML string to swap in (ignored for `delete`).
 * @param target - The element to swap into, replace, or remove.
 * @param method - How to place the content: `innerHTML`, `outerHTML`, `delete`, or an `insertAdjacentHTML` position such as `beforeend`. The names are case-sensitive; `innerHTML` is both the default and the fallback for an unrecognized value.
 * @param source - Marks the swap as `fetch`-driven or `programmatic` (default); surfaced on both lifecycle events.
 */
export function swap(
  content: string,
  target: Element,
  method: SwapMethod = 'innerHTML',
  source: 'fetch' | 'programmatic' = 'programmatic',
) {
  const swapMethod = isSwapMethod(method) ? method : DEFAULT_SWAP_METHOD;
  __DEV__ &&
    swapMethod !== method &&
    warn(
      `Unknown swap method '${method}'. Using '${DEFAULT_SWAP_METHOD}'. Methods are case-sensitive: ${SWAP_METHODS.join(', ')}.`,
      target,
    );

  const dispatcherEl =
    swapMethod === 'outerHTML' || swapMethod === 'delete'
      ? target.parentElement || target
      : target;

  const beforeEvent = dispatch(
    dispatcherEl,
    'rz:dom:swap:before',
    { target, method: swapMethod, payload: content, source },
    { cancelable: true },
  );

  if (beforeEvent.defaultPrevented) return;
  const finalContent = beforeEvent.detail.payload;

  switch (swapMethod) {
    case 'delete':
      target.remove();
      break;
    case 'innerHTML':
      target.innerHTML = finalContent;
      break;
    case 'outerHTML':
      target.outerHTML = finalContent;
      break;
    default:
      target.insertAdjacentHTML(swapMethod, finalContent);
  }

  dispatch(dispatcherEl, 'rz:dom:swap', {
    target,
    method: swapMethod,
    payload: finalContent,
    source,
  });
}
