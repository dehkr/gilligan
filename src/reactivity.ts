import { isObject } from './utils';

let activeEffect: (() => void) | null = null;
const proxyMap = new WeakMap<object, any>();
const targetMap = new WeakMap<object, Map<string | symbol, Set<() => void>>>();

/**
 * Creates a reactive proxy of the source object.
 * 
 * @param target The plain object to make reactive.
 * @returns A reactive Proxy of the target. 
 * @note Always interact with the returned Proxy, not the original target object, 
 * to ensure reactivity is maintained.
 */
export function reactive<T extends object>(target: T): T {
  if (!isObject(target)) {
    return target;
  }

  // If a reactive proxy already exists for this object, return it
  if (proxyMap.has(target)) {
    return proxyMap.get(target);
  }  

  const handler: ProxyHandler<T> = {
    get(target, key, receiver) {
      const result = Reflect.get(target, key, receiver);
      track(target, key);

      // Lazy deep reactivity
      return isObject(result) ? reactive(result) : result;
    },

    set(target, key, value, receiver) {
      const oldValue = Reflect.get(target, key, receiver);
      const result = Reflect.set(target, key, value, receiver);

      // Only trigger if the value actually changed
      if (oldValue !== value) {
        trigger(target, key);
      }
      return result;
    },
  };

  const proxy = new Proxy(target, handler);

  // Cache the proxy before returning it
  proxyMap.set(target, proxy);
  
  return proxy;
}

/**
 * Runs a function immediately and re-runs it whenever its reactive dependencies change.
 * 
 * @param fn The function to execute and track.
 * @returns A stop function that marks the effect as inactive to prevent further runs.
 */
export function effect(fn: () => void): () => void {
  const run = () => {
    // Don't run if the effect has been stopped
    if ((run as any).active === false) return;

    try {
      activeEffect = run;
      fn();
    } finally {
      activeEffect = null;
    }
  };

  (run as any).active = true;

  // Run immediately to capture initial dependencies
  run();

  // Returns the "stop" function. 
  // Uses lazy cleanup: the runner is flagged instead of searching the dependency tree.
  // TODO: consider adding active cleanup
  return () => {
    (run as any).active = false;
  };
}

/**
 * Records the current activeEffect as a dependency of (target, key).
 */
function track(target: object, key: string | symbol) {
  if (!activeEffect) return;
  // Skip tracking if the effect was stopped
  if ((activeEffect as any).active === false) return;

  let depsMap = targetMap.get(target);
  if (!depsMap) {
    depsMap = new Map();
    targetMap.set(target, depsMap);
  }

  let dep = depsMap.get(key);
  if (!dep) {
    dep = new Set();
    depsMap.set(key, dep);
  }

  dep.add(activeEffect);
}

/**
 * Runs all effects that depend on (target, key).
 */
function trigger(target: object, key: string | symbol) {
  const depsMap = targetMap.get(target);
  if (!depsMap) return;

  const dep = depsMap.get(key);
  if (dep) {
    // Clone the Set to avoid infinite loops if an effect mutates the dependency it's reading
    const effectsToRun = new Set(dep);
    effectsToRun.forEach((effectFn) => {
      // Don't run if stopped or if it's the current effect (to prevent recursive loops)
      if (effectFn !== activeEffect && (effectFn as any).active !== false) {
        effectFn();
      } else if ((effectFn as any).active === false) {
        // Clean up dead effects
        dep.delete(effectFn);
      }
    });

    // If the Set is now empty, remove the key to save memory
    if (dep.size === 0) {
      depsMap.delete(key);
    }
  }
}
