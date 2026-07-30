import { directiveSelector, getDirectiveValue } from '../core/attributes';
import { splitInjection } from '../core/injection';
import type { ConfigDirective } from '../types';

function getConfig(
  el: Element,
): { scopeName: string; rawPayload: string | undefined } | null {
  const value = getDirectiveValue(el, 'scope');
  if (value === null) return null;

  const { key: scopeName, rawPayload } = splitInjection(value);

  return { scopeName, rawPayload };
}

export const SCOPE_SELECTOR = directiveSelector('scope');

export const rzScope = { getConfig } as const satisfies ConfigDirective<{
  scopeName: string;
  rawPayload: string | undefined;
} | null>;
