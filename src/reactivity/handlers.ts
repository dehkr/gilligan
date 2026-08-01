import { computed, signal, trigger } from 'alien-signals';
import { methodIntercepts } from './arrays';
import {
  dirtyTrackers,
  getRaw,
  objectRootKeys,
  proxiable,
  reactive,
  untracked,
} from './reactive';

export const ITERATION_KEY = Symbol('rz.iteration');

const signalCache = new WeakMap<object, Map<string | symbol, any>>();
const computedCache = new WeakMap<object, Map<string | symbol, () => any>>();

export const handlers: ProxyHandler<object> = {
  get(target: object, key: string | symbol, receiver: object): any {
    if (key === '__proto__') return target;

    if (Array.isArray(target) && Object.hasOwn(methodIntercepts, key)) {
      return Reflect.get(methodIntercepts, key, receiver);
    }

    // Accessor: wrap getters in `computed` so reads track deps and
    // re-evaluate when those deps change.
    const desc = Object.getOwnPropertyDescriptor(target, key);
    if (desc && typeof desc.get === 'function') {
      const comp = getComputed(target, key, desc.get, receiver)();
      return reactive(comp);
    }

    const value = getSignal(target, key)();

    // Lazy deep reactivity
    if (proxiable(value)) {
      const rawChild = getRaw(value);
      const parentTracker = dirtyTrackers.get(target);

      if (
        parentTracker &&
        !dirtyTrackers.has(rawChild) &&
        Object.getOwnPropertyDescriptor(target, key)?.enumerable !== false
      ) {
        dirtyTrackers.set(rawChild, parentTracker);
        objectRootKeys.set(rawChild, getRootKey(target, key));
      }
      return reactive(value);
    }
    return value;
  },

  set(
    target: Record<string | symbol, unknown>,
    key: string | symbol,
    value: unknown,
    receiver: object,
  ): boolean {
    // Accessor: delegate to the setter if defined. Otherwise `Reflect.set`
    // returns `false` which would cause the write to throw in JS strict mode.
    const desc = Object.getOwnPropertyDescriptor(target, key);
    if (desc && (typeof desc.get === 'function' || typeof desc.set === 'function')) {
      return Reflect.set(target, key, value, receiver);
    }

    const hadKey = Object.hasOwn(target, key);
    const oldValue = target[key];

    value = getRaw(value);

    const result = Reflect.set(target, key, value, receiver);

    if (value !== oldValue) {
      const sig = getSignal(target, key);

      // If the value actually changed (reference change), set it. If it's the same
      // object (mutation), use trigger. Reading untracked keeps a writing effect from
      // subscribing to the key it writes, which would wake it on unrelated writes.
      value !== untracked(sig) ? sig(value) : trigger(sig);

      const tracker = dirtyTrackers.get(target);
      if (tracker) {
        tracker(getRootKey(target, key));
        // Propagate the tracker to the newly-assigned object
        if (proxiable(value)) {
          const rawNew = getRaw(value);
          if (
            !dirtyTrackers.has(rawNew) &&
            Object.getOwnPropertyDescriptor(target, key)?.enumerable !== false
          ) {
            dirtyTrackers.set(rawNew, tracker);
            objectRootKeys.set(rawNew, getRootKey(target, key));
          }
        }
      }

      // Trigger the iteration on structural changes (new keys or any array mutation)
      if (!hadKey || Array.isArray(target)) {
        trigger(getSignal(target, ITERATION_KEY));
      }
    }
    return result;
  },

  ownKeys(target: Record<string | symbol, unknown>): (string | symbol)[] {
    const sig = getSignal(target, Array.isArray(target) ? 'length' : ITERATION_KEY);
    sig();
    return Reflect.ownKeys(target);
  },

  deleteProperty(target, key) {
    const hadKey = Object.hasOwn(target, key);
    const result = Reflect.deleteProperty(target, key);

    // Trigger if the key actually existed and was deleted
    if (result && hadKey) {
      getSignal(target, key)(undefined);
      trigger(getSignal(target, ITERATION_KEY));

      const tracker = dirtyTrackers.get(target);
      if (tracker) {
        tracker(getRootKey(target, key));
      }
    }
    return result;
  },

  has(target, key) {
    // Register dependency. Even if the key doesn't exist, we track
    // the signal so we get notified when added later.
    getSignal(target, key)();
    return Reflect.has(target, key);
  },
};

/**
 * Returns the signal associated with a specific property on a target object.
 * If the signal doesn't exist in the cache, it's created lazily.
 */
export function getSignal(target: object, key: string | symbol) {
  let props = signalCache.get(target);
  if (!props) {
    props = new Map();
    signalCache.set(target, props);
  }
  let sig = props.get(key);
  if (!sig) {
    sig = signal(Reflect.get(target, key));
    props.set(key, sig);
  }
  return sig;
}

/**
 * Returns the computed associated with an accessor property on `target`.
 * Created lazily and bound to `receiver` so `this` inside the getter
 * resolves to the proxy and reads track through it.
 */
function getComputed(
  target: object,
  key: string | symbol,
  getter: () => any,
  receiver: object,
) {
  let cache = computedCache.get(target);
  if (!cache) {
    cache = new Map();
    computedCache.set(target, cache);
  }
  let comp = cache.get(key);
  if (!comp) {
    comp = computed(() => getter.call(receiver));
    cache.set(key, comp);
  }
  return comp;
}

function getRootKey(target: object, key: string | symbol) {
  return objectRootKeys.get(target) ?? (typeof key === 'string' ? key : String(key));
}
