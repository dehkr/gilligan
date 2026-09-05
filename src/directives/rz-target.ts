import { getDirectiveValue, queryTargets } from '../core/attributes';
import {
  DEFAULT_SWAP_METHOD,
  isSwapMethod,
  STORE_PREFIX,
  SWAP_METHODS,
  type SwapOperation,
} from '../core/constants';
import { warn } from '../core/diagnostics';
import { parseDirectiveValue } from '../core/parser';
import type { ConfigDirective } from '../types';

/**
 * Resolves an `rz-target` value into DOM swap operations: selectors resolved to
 * elements, each with its swap method.
 *
 * Store targets moved to `rz-deposit`. Multi-target updates are still supported.
 * An empty value defaults to one swap targeting the host element.
 *
 * - `data-rz-target="afterbegin: #output"`
 * - `data-rz-target="#output"`
 * - `data-rz-target="outerHTML"`
 * - `data-rz-target="beforeend: #log, #status"`
 *
 * @param overrideValue - Takes precedence over the element's `rz-target` attribute (e.g. a server `Rouse-Target` header).
 */
function getConfig(el: Element, appRoot: Element, overrideValue?: string | null) {
  const value = overrideValue || getDirectiveValue(el, 'target');
  return resolveRouteTargets(value, el, appRoot);
}

function resolveRouteTargets(
  value: string | null | undefined,
  hostEl: Element,
  appRoot: Element,
): SwapOperation[] {
  const parsed = value?.trim() ? parseDirectiveValue(value) : [];

  if (parsed.length === 0) {
    // Prevent a store script that hosts an rz-sse stream from inserting HTML
    // payloads by default. It would be inert, but not correct behavior. Doesn't
    // affect explicit rz-target usage.
    if (hostEl instanceof HTMLScriptElement) {
      return [];
    }

    return [{ targets: [hostEl], method: DEFAULT_SWAP_METHOD }];
  }

  const swaps: SwapOperation[] = [];

  // Three forms: 'method: selector', a bare method (targets the host element),
  // or a bare selector (default method).
  for (const [key, val] of parsed) {
    const store = key.startsWith(STORE_PREFIX) ? key : val;
    if (store?.startsWith(STORE_PREFIX)) {
      __DEV__ &&
        warn(
          `rz-target: '${store}' names a store. Use data-rz-deposit for store targets.`,
          hostEl,
        );
      continue;
    }

    if (val) {
      const method = isSwapMethod(key) ? key : DEFAULT_SWAP_METHOD;
      __DEV__ &&
        method !== key &&
        warn(
          `rz-target: unknown swap method '${key}'. Using '${DEFAULT_SWAP_METHOD}'. Methods are case-sensitive: ${SWAP_METHODS.join(', ')}.`,
          hostEl,
        );
      swaps.push({ method, targets: queryEls(appRoot, val, hostEl) });
    } else if (isSwapMethod(key)) {
      swaps.push({ targets: [hostEl], method: key });
    } else {
      swaps.push({
        targets: queryEls(appRoot, key, hostEl),
        method: DEFAULT_SWAP_METHOD,
      });
    }
  }

  return swaps;
}

function queryEls(appRoot: Element, selector: string, hostEl: Element): Element[] {
  const targets = queryTargets(appRoot, selector);
  __DEV__ &&
    targets.length === 0 &&
    warn(`rz-target: no targets found for '${selector}'.`, hostEl);

  return targets;
}

export const rzTarget = {
  getConfig,
} as const satisfies ConfigDirective<SwapOperation[]>;
