import { KEY_BLOCKLIST } from './constants';
import { warn } from './diagnostics';

const MAX_CACHE_SIZE = 500;
const pathCache = new Map<string, string[]>();

/**
 * Resolves a dot-notation path to a value.
 */
export function getNestedVal<T = unknown>(
  obj: any,
  path: string | undefined,
): T | undefined {
  if (!obj || !path) return undefined;

  const parts = getPathParts(path);
  let current = obj;

  for (const part of parts) {
    if (current == null) return undefined;
    current = current[part];
  }

  return current as T;
}

/**
 * Sets a value at a dot-notation path.
 */
export function setNestedVal(obj: any, path: string | undefined, value: any): void {
  if (!obj || typeof obj !== 'object' || !path) return;

  const parts = getPathParts(path);
  const lastKey = parts[parts.length - 1];

  // Early exit if last key is on block list
  if (lastKey === undefined || KEY_BLOCKLIST.includes(lastKey)) return;

  let current = obj;

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i] as string;
    if (KEY_BLOCKLIST.includes(part)) return;

    if (!(part in current) || current[part] == null) {
      // Convert to empty object to enable traversal
      current[part] = {};
    } else if (typeof current[part] !== 'object') {
      __DEV__ && warn(`Cannot write to '${path}': '${part}' is a primitive.`);
      return;
    }
    current = current[part];
  }
  current[lastKey] = value;
}

/**
 * Deletes the value at `path`. Walks to the parent and removes the leaf key. A missing
 * or primitive intermediate is a no-op since there is nothing to delete.
 */
export function deleteNestedVal(obj: any, path: string | undefined): void {
  if (!obj || typeof obj !== 'object' || !path) return;

  const parts = getPathParts(path);
  const lastKey = parts[parts.length - 1];

  if (lastKey === undefined || KEY_BLOCKLIST.includes(lastKey)) return;

  let current = obj;

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i] as string;
    if (KEY_BLOCKLIST.includes(part)) return;
    if (current[part] == null || typeof current[part] !== 'object') return;
    current = current[part];
  }

  delete current[lastKey];
}

/**
 * Returns the first segment of a dot-path, or `undefined` when the path is
 * empty. Maps a nested path back to its root store/scope key.
 */
export function getPathRoot(path: string | undefined): string | undefined {
  if (!path) return;
  return getPathParts(path)[0];
}

/**
 * Splits a path string into individual parts and returns an array of the parts. Also
 * manages the path cache, deleting the oldest entries when cache is full (FIFO).
 */
export function getPathParts(path: string): string[] {
  let parts = pathCache.get(path);
  if (!parts) {
    parts = path.split('.');
    if (pathCache.size >= MAX_CACHE_SIZE) {
      const firstKey = pathCache.keys().next().value as string;
      pathCache.delete(firstKey);
    }
    pathCache.set(path, parts);
  }

  return parts;
}
