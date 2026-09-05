import { getDirectiveValue } from '../core/attributes';
import { STORE_PREFIX } from '../core/constants';
import { warn } from '../core/diagnostics';
import { parseDirectiveValue, parseStoreRef } from '../core/parser';
import type { ConfigDirective } from '../types';

/**
 * Resolves `rz-deposit` into store names a JSON payload is routed to. For a
 * fetch response or an unnamed stream message.
 *
 * Whole stores only, comma separated. A nested path is a reconciliation concern
 * and belongs to `rz-pull`, which guards against clobbering in-flight edits.
 *
 * - `data-rz-deposit="@cart"`
 * - `data-rz-deposit="@cart, @status"`
 *
 * @param overrideValue - Takes precedence over the attribute (a server `Rouse-Target` header).
 */
function getConfig(el: Element, overrideValue?: string | null): string[] {
  const value = overrideValue || getDirectiveValue(el, 'deposit');

  // A <script data-rz-store> is its own deposit target, matching how `rz-push`
  // and `rz-pull` resolve a missing subject.
  if (!value?.trim()) {
    const selfName = getDirectiveValue(el, 'store')?.trim();
    return selfName ? [selfName] : [];
  }

  const stores: string[] = [];

  for (const [key] of parseDirectiveValue(value)) {
    if (!key.startsWith(STORE_PREFIX)) {
      // A server override may name a DOM target instead, which is the swapper's business
      __DEV__ &&
        !overrideValue &&
        warn(`rz-deposit: '${key}' is not a store reference. Use '@name'.`, el);
      continue;
    }

    const ref = parseStoreRef(key, 'deposit');
    if (!ref) continue;

    if (ref.nestedPath) {
      __DEV__ &&
        warn(
          `rz-deposit: '${key}' targets a slice. A deposit writes a whole store; use rz-pull to sync a nested path.`,
          el,
        );
      continue;
    }

    stores.push(ref.source);
  }

  return stores;
}

export const rzDeposit = { getConfig } as const satisfies ConfigDirective<string[]>;
