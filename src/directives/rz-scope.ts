import { directiveSelector, getDirectiveValue } from '../core/attributes';
import type { ConfigDirective } from '../types';

function getConfig(el: Element): string | null {
  return getDirectiveValue(el, 'scope');
}

export const SCOPE_SELECTOR = directiveSelector('scope');

export const rzScope = { getConfig } as const satisfies ConfigDirective<string | null>;
