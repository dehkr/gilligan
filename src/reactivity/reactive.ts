import { setActiveSub } from 'alien-signals';
import { handlers } from './handlers';

export type ReactiveProxy<T> = T;

const proxyCache = new WeakMap();
const rawCache = new WeakMap();

export const dirtyTrackers = new WeakMap<object, (rootKey: string) => void>();
export const objectRootKeys = new WeakMap<object, string>();

/**
 * Creates a reactive proxy for the target object.
 *
 * - If passed a raw object, it returns its reactive proxy (creating one if needed).
 * - If passed an existing proxy, it returns it as-is.
 * - If passed a non-proxiable value (primitive, DOM node), it returns it as-is.
 *
 * The returned proxy is deeply reactive but lazy: nested properties are converted to
 * proxies only when accessed.
 *
 * @template T - The type of the target object.
 * @param target - The object to make reactive.
 * @returns The reactive proxy, or the original value if it cannot be proxied.
 *
 * @example
 * const state = reactive({ count: 0 });
 * effect(() => console.log(state.count));
 */
export function reactive<T extends object>(target: T): ReactiveProxy<T> {
  if (!proxiable(target)) return target;
  if (rawCache.has(target)) return target;
  if (proxyCache.has(target)) return proxyCache.get(target);

  const proxy = new Proxy(target, handlers as ProxyHandler<any>);

  proxyCache.set(target, proxy);
  rawCache.set(proxy, target);

  return proxy as ReactiveProxy<T>;
}

/**
 * Makes sure the target is eligible to be a proxy.
 */
export function proxiable(target: unknown): target is object {
  if (target === null || typeof target !== 'object') return false;
  if (Array.isArray(target)) return true;

  return Object.prototype.toString.call(target) === '[object Object]';
}

/**
 * Returns the original raw object of a proxy.
 */
export function getRaw<T>(target: T): T {
  const raw = rawCache.get(target as object);
  return raw ? (getRaw(raw) as T) : target;
}

/**
 * Registers a callback to track mutations back to their root property.
 */
export function trackDirty<T extends object>(
  target: T,
  callback: (rootKey: string) => void,
) {
  const raw = getRaw(target);
  if (raw) {
    dirtyTrackers.set(raw, callback);
  }
}

/**
 * Read every enumerable key through the proxy to fire the get trap.
 */
export function seedPropagation(obj: any, seen = new WeakSet()): void {
  if (!obj || typeof obj !== 'object' || seen.has(obj)) return;
  seen.add(obj);
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    seedPropagation(value, seen);
  }
}

/**
 * Runs `fn` without linking the reads or any effects created inside it to the
 * current tracking context. Used by `rz-render` so per-instance directive
 * effects survive the parent render effect re-running (and don't leak into it).
 */
export function untracked<T>(fn: () => T): T {
  const prev = setActiveSub(undefined);
  try {
    return fn();
  } finally {
    setActiveSub(prev);
  }
}
