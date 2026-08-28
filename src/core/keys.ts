// Session stamp guards keys that outlive the page (e.g. pushed to a server).
// Counter starts at 36^3 so every key renders at fixed width.
const session = Date.now().toString(36);
let count = 46656;

/**
 * Generates a short key, unique for the lifetime of the page. Intended for
 * assigning stable identity to client-created items in keyed lists.
 *
 * Call it once when creating the item and store the result on the item. Never
 * call it during render or inside a getter because every call returns a new key,
 * which defeats keyed reconciliation. Keys are sequential, not random. Don't use
 * them as secrets or persist them as permanent ids.
 *
 * @example
 * const key = createKey(); // 'rz_mbx3k2f81000'
 * todos.items.push({ key, text });
 * // In HTML, use as stable id via `rz-key`
 * <template data-rz-render="items" data-rz-key="key">
 */
export function createKey(prefix = 'rz_') {
  return prefix + session + (count++).toString(36);
}
