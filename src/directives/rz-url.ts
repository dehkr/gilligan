import { getDirectiveValue } from '../core/attributes';
import type { ConfigDirective } from '../types';

/**
 * The request URL for an element. Read by `rz-fetch` (and by `rz-store` for a
 * store's sync URL). The attribute value is passed through without validation,
 * leaving the browser to resolve it as a relative or absolute URL.
 *
 * @example
 * <button rz-url="/api/users" rz-fetch="click: POST">Save</button>
 */
function getConfig(el: Element): { url: string } {
  return { url: getDirectiveValue(el, 'url')?.trim() ?? '' };
}

export const rzUrl = { getConfig } as const satisfies ConfigDirective<{ url: string }>;
