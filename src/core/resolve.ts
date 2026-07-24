import type { Scope } from '../types';
import { ITEM_PREFIX, STORE_PREFIX } from './constants';
import { warn } from './diagnostics';
import { parseDataSourcePath } from './parser';
import { getNestedVal, getPathParts, setNestedVal } from './path';
import { renderItem, renderParent } from './render-context';
import type { StoreManager } from './store';

export const EMPTY_SCOPE = {} as Scope;
const warnedWrites = new Set<string>();

/**
 * Resolves a path against a global store, a local scope, or a render item.
 */
export function resolveState<T = unknown>(
  path: string,
  scope: Scope,
  storeManager: StoreManager,
): T | undefined {
  // Render item
  if (path.startsWith(ITEM_PREFIX)) {
    const itemPath = path.slice(1);
    const item = renderItem(scope);
    return itemPath ? getNestedVal<T>(item, itemPath) : (item as T | undefined);
  }

  // Global store
  if (path.startsWith(STORE_PREFIX)) {
    const { source: storeName, nestedPath } = parseDataSourcePath(path);
    const store = storeManager.get(storeName);
    return nestedPath ? getNestedVal<T>(store, nestedPath) : (store as T | undefined);
  }

  // Fallback to local scope state
  return getNestedVal<T>(scope, path);
}

/**
 * Writes a value to a global store, a local scope, or a render item.
 *
 * **Note:** Currently this is used exclusively as the write path for `rz-model`.
 * The warnings reflect that. They should be updated if another caller is added.
 */
export function writeState(
  path: string,
  value: unknown,
  scope: Scope,
  storeManager: StoreManager,
): void {
  // Render item
  if (path.startsWith(ITEM_PREFIX)) {
    const itemPath = path.slice(1);
    if (!itemPath) {
      __DEV__ &&
        warnWriteOnce(
          path,
          `rz-model: cannot use '${path}' because it overwrites the entire render item. Bind to a field instead.`,
        );
      return;
    }

    const item = renderItem(scope);
    if (!hasNestedKey(item, itemPath)) {
      __DEV__ &&
        warnWriteOnce(
          path,
          `rz-model: '${path}' could not be resolved. Field does not exist on the render item.`,
        );
      return;
    }

    setNestedVal(item, itemPath, value);
    return;
  }

  // Global store
  if (path.startsWith(STORE_PREFIX)) {
    const { source: storeName, nestedPath } = parseDataSourcePath(path);

    if (!nestedPath) {
      __DEV__ &&
        warnWriteOnce(
          path,
          `rz-model: cannot use '${path}' because it overwrites the entire store. Bind to a field instead.`,
        );
      return;
    }

    const storeData = storeManager.get(storeName);

    // Warns if store doesn't exist, or if key doesn't exist on store
    if (!hasNestedKey(storeData, nestedPath)) {
      __DEV__ &&
        warnWriteOnce(
          path,
          `rz-model: cannot resolve '${path}' on '${storeName}'. One or both may be undefined.`,
        );
      return;
    }

    setNestedVal(storeData, nestedPath, value);
    return;
  }

  // Fallback to local scope state
  if (renderParent(scope) === EMPTY_SCOPE) {
    __DEV__ &&
      warnWriteOnce(
        path,
        `rz-model: '${path}' used outside of a scope. Use '@' to target a store.`,
      );
    return;
  }

  if (!hasNestedKey(scope, path)) {
    __DEV__ && warnWriteOnce(path, `rz-model: '${path}' does not exist on the scope.`);
    return;
  }

  setNestedVal(scope, path, value);
}

/**
 * Checks if `path` resolves to an existing key on `obj`. Guards `writeState` against
 * `rz-model` writes to non-existent fields. `setNestedVal` would otherwise create
 * them. Server-driven creates bypass `writeState`, so they're unaffected.
 */
function hasNestedKey(obj: unknown, path: string): boolean {
  const parts = getPathParts(path);
  let current = obj as any;

  for (let i = 0; i < parts.length - 1; i++) {
    if (current == null || typeof current !== 'object') {
      return false;
    }
    current = current[parts[i] as string];
  }

  return (
    current != null &&
    typeof current === 'object' &&
    (parts[parts.length - 1] as string) in current
  );
}

/**
 * Dedupes per-keystroke `rz-model` repeat warnings.
 */
function warnWriteOnce(path: string, message: string): void {
  if (warnedWrites.has(path)) return;
  warnedWrites.add(path);
  warn(message);
}
