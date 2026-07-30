import { getDirectiveValue } from '../core/attributes';
import type { ConfigDirective } from '../types';

/**
 * Explicit reconciliation key for `rz-render`. Holds an item path resolved per
 * instance (e.g. `rz-key="id"` or `rz-key="user.id"`). Encouraged for any list
 * that reorders or is refetched, so instances reuse DOM by stable identity.
 * Without it, `rz-render` keys by position.
 *
 * @example
 * <template rz-render="@todos.items" rz-key="id">
 */
function getConfig(el: Element): string | null {
  return getDirectiveValue(el, 'key')?.trim() || null;
}

export const rzKey = { getConfig } as const satisfies ConfigDirective<string | null>;
