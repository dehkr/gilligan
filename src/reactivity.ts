export interface ReactiveEffect {
  (): void;
  deps: Set<ReactiveEffect>[];
}

// Store nested effects
const effectStack: ReactiveEffect[] = [];

// Cache stores raw object -> proxy
const proxyMap = new WeakMap<object, any>();

export function reactive<T extends object>(obj: T): T {
  // Check cache and return proxy for object if it already exists
  if (proxyMap.has(obj)) {
    return proxyMap.get(obj);
  }

  const subscribers = new Map<string | symbol, Set<ReactiveEffect>>();

  const proxy = new Proxy(obj, {
    get(target, key, receiver) {
      const result = Reflect.get(target, key, receiver);

      // Track dependency
      const activeEffect = effectStack[effectStack.length - 1];

      if (activeEffect) {
        if (!subscribers.has(key)) {
          subscribers.set(key, new Set());
        }
        const depSet = subscribers.get(key)!;
        depSet.add(activeEffect);
        activeEffect.deps.push(depSet);
      }

      // Lazy deep reactivity
      if (result !== null && typeof result === 'object') {
        return reactive(result);
      }
      return result;
    },

    set(target, key, value, receiver) {
      const oldValue = Reflect.get(target, key, receiver);
      const result = Reflect.set(target, key, value, receiver);

      if (oldValue !== value) {
        // Snapshot to avoid infinite loops
        const effectsToRun = new Set(subscribers.get(key));
        effectsToRun.forEach((eff) => {
          eff();
        });
      }
      return result;
    },
  });

  // Save to cache
  proxyMap.set(obj, proxy);

  return proxy;
}

export function effect(fn: () => void): () => void {
  const wrappedEffect: ReactiveEffect = () => {
    cleanupEffect(wrappedEffect);
    try {
      effectStack.push(wrappedEffect);
      fn();
    } finally {
      effectStack.pop();
    }
  };

  wrappedEffect.deps = [];
  wrappedEffect();

  // Returns cleanup function to unsubscribe the effect
  return () => cleanupEffect(wrappedEffect);
}

function cleanupEffect(eff: ReactiveEffect) {
  eff.deps.forEach((dep) => {
    dep.delete(eff);
  });
  eff.deps.length = 0;
}
