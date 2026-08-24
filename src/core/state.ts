import { warn } from './diagnostics';

/**
 * Returns true if `obj[key]` is a serializable own data property. Excludes
 * accessors (get/set) and function-valued properties. Used by `clone`,
 * `deepEqual`, and `patchState` so all three agree on what counts as state
 * worth snapshotting, diffing, or writing back.
 */
export function isOwnDataProp(obj: object, key: string): boolean {
  const desc = Object.getOwnPropertyDescriptor(obj, key);
  if (!desc) return false;
  if (desc.get || desc.set) return false;
  if (typeof desc.value === 'function') return false;
  return true;
}

/**
 * Deep-clone `obj`, stripping non-serializable properties (functions,
 * `undefined`, and accessors). Produces snapshots safe to JSON-serialize,
 * diff, or use as rollback targets.
 */
export function clone<T>(obj: T, seen = new WeakMap(), path = 'root'): T {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  if (seen.has(obj as any)) {
    return seen.get(obj as any);
  }

  // Arrays: JSON converts functions/undefined to null to preserve indexes.
  // This also normalizes sparse arrays (holes become null).
  if (Array.isArray(obj)) {
    const arr = [] as any[];
    seen.set(obj as any, arr);
    for (let i = 0; i < obj.length; i++) {
      const val = obj[i];
      // Pass path + index for array debugging
      arr[i] =
        typeof val === 'function' || val === undefined
          ? null
          : clone(val, seen, `${path}[${i}]`);
    }
    return arr as unknown as T;
  }

  // Catch complex objects before network sync
  if (!isPlainObject(obj)) {
    __DEV__ &&
      warn(
        `Non-serializable value at '${path}'. Use plain objects, arrays, or primitives.`,
      );
    return {} as T;
  }

  // Objects: JSON completely strips properties that are functions or undefined.
  const result = {} as Record<string, any>;
  seen.set(obj as any, result);

  for (const key in obj) {
    if (!isOwnDataProp(obj as object, key)) continue;
    const val = (obj as Record<string, any>)[key];
    if (val !== undefined) {
      result[key] = clone(val, seen, `${path}.${key}`);
    }
  }

  return result as T;
}

/**
 * Collects the dot-paths of every object property holding `null`. Arrays are not
 * traversed: they overwrite wholesale under RFC 7396, so a null inside one is a
 * value rather than a tombstone.
 */
export function nullPaths(obj: unknown, seen = new WeakSet(), path = ''): string[] {
  if (!isPlainObject(obj) || seen.has(obj)) return [];
  seen.add(obj);

  return Object.keys(obj).flatMap((key) => {
    if (!isOwnDataProp(obj, key)) return [];

    const val = obj[key];
    const keyPath = path ? `${path}.${key}` : key;

    return val === null ? [keyPath] : nullPaths(val, seen, keyPath);
  });
}

/**
 * Compare two values for deep equality. Skip the same properties `clone()` strips,
 * so a value always compares equal to its own clone.
 */
export function deepEqual(a: any, b: any, seen = new WeakMap<object, any>()): boolean {
  if (a === b) {
    return true;
  }

  // Handle NaN !== NaN
  if (
    typeof a === 'number' &&
    typeof b === 'number' &&
    Number.isNaN(a) &&
    Number.isNaN(b)
  ) {
    return true;
  }

  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false;
  }

  if (seen.has(a)) {
    return seen.get(a) === b;
  }
  seen.set(a, b);

  // Fast path: constructor check
  if (a.constructor !== b.constructor) {
    return false;
  }
  if (a instanceof Date) {
    return a.getTime() === b.getTime();
  }
  if (a instanceof RegExp) {
    return a.toString() === b.toString();
  }

  // Arrays: match JSON behavior by converting functions/undefined to null
  if (Array.isArray(a)) {
    if (a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i++) {
      const valA = typeof a[i] === 'function' || a[i] === undefined ? null : a[i];
      const valB = typeof b[i] === 'function' || b[i] === undefined ? null : b[i];
      if (!deepEqual(valA, valB, seen)) {
        return false;
      }
    }
    return true;
  }

  // Objects
  let validKeysA = 0;
  for (const key in a) {
    if (!isOwnDataProp(a, key)) continue;
    const valA = a[key];
    if (valA !== undefined) {
      validKeysA++;
      if (!Object.hasOwn(b, key)) return false;
      if (!deepEqual(valA, b[key], seen)) return false;
    }
  }

  // Count valid keys in B to ensure no extra serializable keys exist
  let validKeysB = 0;
  for (const key in b) {
    if (!isOwnDataProp(b, key)) continue;
    const valB = b[key];
    if (valB !== undefined) {
      validKeysB++;
    }
  }

  return validKeysA === validKeysB;
}

/**
 * Writes `source` into `target`. `replace` deletes keys absent from the source;
 * `merge` applies JSON Merge Patch (RFC 7396) semantics, where absent keys are
 * left alone and a `null` removes the key it names.
 */
export function patchState(
  target: Record<string, any>,
  source: Record<string, any>,
  action: 'replace' | 'merge' = 'replace',
) {
  // Replace
  if (action === 'replace') {
    for (const key of Object.keys(target)) {
      if (!isOwnDataProp(target, key)) continue;
      if (!Object.hasOwn(source, key)) delete target[key];
    }
    // Write source values into target, skipping keys where target has an accessor.
    // Writing through a getter-only accessor would throw, and even when a setter
    // exists, this loop is for data-property merge.
    for (const key of Object.keys(source)) {
      if (!isOwnDataProp(target, key) && Object.getOwnPropertyDescriptor(target, key)) {
        continue;
      }
      target[key] = source[key];
    }
    return;
  }

  // Merge
  for (const sourceKey of Object.keys(source)) {
    if (!isOwnDataProp(source, sourceKey)) continue;

    const sourceVal = (source as Record<string, any>)[sourceKey];
    if (sourceVal === undefined) continue;

    // Skip if target has an accessor at this key. Can't write to derived state.
    if (
      !isOwnDataProp(target, sourceKey) &&
      Object.getOwnPropertyDescriptor(target, sourceKey)
    ) {
      continue;
    }

    // RFC 7396: null values indicate removal
    if (sourceVal === null) {
      delete target[sourceKey];
      continue;
    }

    const targetVal = target[sourceKey];

    // An object patched over a non-object target seeds `{}` and merges into it
    // rather than being assigned wholesale, which is what drops the nulls nested
    // inside it. Re-read after seeding: the proxy wraps what was just written.
    if (isPlainObject(sourceVal)) {
      if (isPlainObject(targetVal)) {
        patchState(targetVal, sourceVal, 'merge');
      } else {
        target[sourceKey] = {};
        patchState(target[sourceKey], sourceVal, 'merge');
      }
    } else {
      target[sourceKey] = sourceVal;
    }
  }
}

/**
 * Checks that a value is a plain JavaScript object (POJO).
 * Excludes Arrays, Dates, Maps, and custom class instances.
 */
export function isPlainObject(val: unknown): val is Record<string, any> {
  if (typeof val !== 'object' || val === null || Array.isArray(val)) {
    return false;
  }
  const proto = Object.getPrototypeOf(val);

  // Matches {} (Object.prototype) and Object.create(null)
  return proto === null || proto === Object.prototype;
}
