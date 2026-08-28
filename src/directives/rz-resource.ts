import { getDirectiveValue } from '../core/attributes';
import { warn } from '../core/diagnostics';
import type { ConfigDirective } from '../types';

/**
 * The endpoint a store pushes to and pulls from. Takes a URL and nothing else.
 *
 * @example
 * <script data-rz-store="cart" data-rz-resource="/api/cart" type="application/json">
 */
function getConfig(el: Element): string | null {
  const value = getDirectiveValue(el, 'resource');
  if (value === null) return null;

  const url = value.trim();
  if (!url) {
    __DEV__ && warn(`rz-resource: value is missing or empty.`, el);
    return null;
  }

  return url;
}

export const rzResource = { getConfig } as const satisfies ConfigDirective<string | null>;
