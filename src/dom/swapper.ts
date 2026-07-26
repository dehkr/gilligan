import type { RouseApp } from '../core/app';
import {
  DEFAULT_SWAP_METHOD,
  isSwapMethod,
  SWAP_METHODS,
  type SwapMethod,
} from '../core/constants';
import { warn } from '../core/diagnostics';
import { rzTarget } from '../directives';
import type { RouseResponse } from '../types';
import { dispatch } from './events';

/**
 * Listens to the app root for HTML fetch responses and routes the payloads into DOM
 * targets named by `rz-target` or a server `Rouse-Target` header. Error responses route
 * only when the server names a target, since `rz-target` is success-only output.
 */
export function initDomRouter(app: RouseApp, signal: AbortSignal) {
  const route = (e: Event) => {
    const { target, detail } = e as CustomEvent<RouseResponse>;
    const { config, data, targetOverride } = detail;

    // Programmatic `fetch` defaults to `swap: false`; it doesn't auto-update the DOM
    if (config?.swap === false) return;
    // An empty response (`null`) or non-string body has nothing to swap
    if (typeof data !== 'string') return;
    // Don't route an error response unless the server provides an override
    if (e.type.includes('error') && !targetOverride) return;

    const operations = rzTarget.getConfig(
      target as Element,
      app.root,
      targetOverride,
    ).swaps;

    for (const { targets, method } of operations) {
      for (const targetEl of targets) {
        swap(data, targetEl, method, 'fetch');
      }
    }
  };

  for (const eventType of ['success', 'error']) {
    app.root.addEventListener(`rz:fetch:${eventType}:html`, route, { signal });
  }
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
