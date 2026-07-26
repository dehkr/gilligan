import { getDirectiveValue, queryTargets } from '../core/attributes';
import {
  DEFAULT_SWAP_METHOD,
  isSwapMethod,
  STORE_PREFIX,
  SWAP_METHODS,
  type SwapOperation,
  type TargetConfig,
} from '../core/constants';
import { warn } from '../core/diagnostics';
import { parseDirectiveValue } from '../core/parser';
import type { ConfigDirective } from '../types';

/**
 * Resolves an `rz-target` value into its routing targets: DOM `swaps`
 * (selectors resolved to elements, each with its swap method) and `@store`
 * target names.
 *
 * Returns an object with two arrays: one containing swap operations and a
 * separate one for store targets. Multi-target updates are supported, including
 * combining DOM and store targets. HTML responses ignore store targets, and JSON
 * responses ignore DOM targets.
 *
 * An empty value defaults to one swap targeting the host element.
 *
 * - `rz-target="afterbegin: #output"`
 * - `rz-target="#output"`
 * - `rz-target="outerHTML"`
 * - `rz-target="@store"`
 * - `rz-target="@status, beforeend: #status"`
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
): TargetConfig {
  const swaps: SwapOperation[] = [];
  const stores: string[] = [];
  const parsed = value?.trim() ? parseDirectiveValue(value) : [];

  if (parsed.length === 0) {
    swaps.push({ targets: [hostEl], method: DEFAULT_SWAP_METHOD });
    return { swaps, stores };
  }

  // Each pair is one of four forms: '@store' (on either side), 'method: selector',
  // a bare method (targets the host element), or a bare selector (default method).
  // Store targets only collect a name for the JSON router; they never DOM swap.
  for (const [key, val] of parsed) {
    const store = key.startsWith(STORE_PREFIX)
      ? key
      : val?.startsWith(STORE_PREFIX)
        ? val
        : '';
    if (store) {
      stores.push(store.slice(1));
    } else if (val) {
      const method = isSwapMethod(key) ? key : DEFAULT_SWAP_METHOD;
      __DEV__ &&
        method !== key &&
        warn(
          `rz-target: unknown swap method '${key}'. Using '${DEFAULT_SWAP_METHOD}'. Methods are case-sensitive: ${SWAP_METHODS.join(', ')}.`,
          hostEl,
        );
      swaps.push({ method, targets: queryEls(appRoot, val) });
    } else if (isSwapMethod(key)) {
      swaps.push({ targets: [hostEl], method: key });
    } else {
      swaps.push({ targets: queryEls(appRoot, key), method: DEFAULT_SWAP_METHOD });
    }
  }

  return { swaps, stores };
}

function queryEls(appRoot: Element, selector: string): Element[] {
  const targets = queryTargets(appRoot, selector);
  __DEV__ && targets.length === 0 && warn(`No targets found for '${selector}'.`);

  return targets;
}

export const rzTarget = {
  slug: 'target',
  getConfig,
} as const satisfies ConfigDirective<TargetConfig>;
