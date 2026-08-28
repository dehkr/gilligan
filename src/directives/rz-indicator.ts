import { getDirectiveValue } from '../core/attributes';
import type { ConfigDirective } from '../types';

/**
 * A CSS selector for the elements that receive the `rouse-request` class while a
 * request from the host element is in flight. Without it, the host element receives
 * the class itself. Write `null` to apply it to nothing.
 *
 * @example
 * <button data-rz-fetch="click: /save" data-rz-indicator="#spinner">Save</button>
 */
function getConfig(el: Element): string | null | undefined {
  const value = getDirectiveValue(el, 'indicator')?.trim();
  if (!value) return undefined;

  // Treat 'null' as the suppression sentinel, mirroring programmatic null
  return value === 'null' ? null : value;
}

export const rzIndicator = { getConfig } as const satisfies ConfigDirective<
  string | null | undefined
>;
