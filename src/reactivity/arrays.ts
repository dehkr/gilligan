import { endBatch, startBatch, trigger } from 'alien-signals';
import type { AnyFn } from '../types';
import { getSignal, ITERATION_KEY } from './handlers';
import { dirtyTrackers, getRaw, objectRootKeys, reactive } from './reactive';

/** Array-method overrides keyed by name/symbol. */
export const methodIntercepts: Record<string | symbol, AnyFn> = {};

/**
 * Methods that take stored values, not callbacks, in their argument list. A
 * function passed to one of these is data to keep, not a callback to decorate.
 */
const DATA_ARG_METHODS = new Set(['concat', 'with', 'toSpliced']);

/**
 * Unwraps a reactive array and runs the given method (like `find`, `forEach`,
 * or `map`) on the raw contents, handing any callback it's given reactive versions
 * of the item, `this`, and the array so code inside still tracks changes.
 *
 * Reads the array's iteration signal (via `getSignal`), so when this runs inside
 * an effect or computed, that effect re-runs whenever the array mutates.
 *
 * @param wrapResult - For methods that return a new array, re-wrap its items
 * in proxies before returning.
 */
function runOnRaw(proxy: any[], method: string, args: any[], wrapResult = false) {
  const raw = trackedRaw(proxy);
  const isReduce = method === 'reduce' || method === 'reduceRight';
  const isData = DATA_ARG_METHODS.has(method);
  // `reduce` has no thisArg parameter; its second argument is the initial value
  const thisArg = isReduce ? proxy : (args[1] ?? proxy);

  const wrappedArgs = args.map((arg) => {
    if (isData || typeof arg !== 'function') return arg;

    // For reduce methods, pass the accumulator through unproxied; it's the callback's
    // own value, not an array element, so wrapping it would proxy an object the caller
    // already owns.
    return isReduce
      ? (acc: any, item: any, index: number) =>
          arg.call(thisArg, acc, reactive(item), index, proxy)
      : (item: any, index: number) => arg.call(thisArg, reactive(item), index, proxy);
  });

  const result = raw[method](...wrappedArgs);

  // Methods like `map`, `filter`, and `slice` build a new array whose items may
  // be unproxied, so they are re-wrapped here. `reactive` reuses an item's existing
  // proxy, or creates one, and passes non-objects through.
  if (wrapResult && Array.isArray(result)) {
    return result.map(reactive);
  }

  return result;
}

/**
 * Unwraps to the raw array and registers the iteration dependency, so any read
 * performed through it re-runs the surrounding effect when the array mutates.
 */
function trackedRaw(proxy: any[]) {
  const raw = getRaw(proxy) as any;
  getSignal(raw, ITERATION_KEY)();
  return raw;
}

const MUTATORS = [
  'copyWithin',
  'fill',
  'pop',
  'push',
  'reverse',
  'shift',
  'sort',
  'splice',
  'unshift',
] as const;

// Batch updates, run on raw, and manually trigger 'length' and iteration signals
for (const key of MUTATORS) {
  methodIntercepts[key] = function (this: any[], ...args: any[]) {
    startBatch();
    try {
      const raw = getRaw(this);
      const result = raw[key].apply(raw, args);

      // Trigger the signals affected by mutation
      getSignal(raw, 'length')(raw.length);
      trigger(getSignal(raw, ITERATION_KEY));

      const tracker = dirtyTrackers.get(raw);
      if (tracker) {
        const rootKey = objectRootKeys.get(raw) ?? 'root';
        tracker(rootKey);
      }
      return result;
    } finally {
      endBatch();
    }
  };
}

const SEARCHERS = ['includes', 'indexOf', 'lastIndexOf'] as const;

// Track iteration, run on raw, and retry with raw args if search fails (handles proxies)
for (const key of SEARCHERS) {
  methodIntercepts[key] = function (this: any[], ...args: any[]) {
    const raw = trackedRaw(this);
    let result = raw[key](...args);
    // Try unwrapping args (in case a proxy was passed to search)
    if (result === -1 || result === false) {
      const rawArgs = args.map(getRaw);
      result = raw[key](...rawArgs);
    }
    return result;
  };
}

const ITERATORS = ['entries', 'keys', 'values', Symbol.iterator] as const;

// Track iteration, get raw iterator, and yield reactive proxies for safe loops
for (const key of ITERATORS) {
  methodIntercepts[key] = function* (this: any[]) {
    const raw = trackedRaw(this);
    const iterator = raw[key]();
    for (const val of iterator) {
      yield reactive(val);
    }
  };
}

const CONSUMERS = [
  'at',
  'every',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'forEach',
  'reduce',
  'reduceRight',
  'some',
] as const;

// Run on raw, proxy callback arguments, and wrap the return value if it's an object
for (const key of CONSUMERS) {
  methodIntercepts[key] = function (this: any[], ...args: any[]) {
    const result = runOnRaw(this, key, args);
    return reactive(result);
  };
}

const PRODUCERS = [
  'concat',
  'filter',
  'flat',
  'flatMap',
  'map',
  'slice',
  'toReversed',
  'toSorted',
  'toSpliced',
  'with',
] as const;

// Run on raw with proxied callback args, then wrap the resulting array items in proxies
for (const key of PRODUCERS) {
  methodIntercepts[key] = function (this: any[], ...args: any[]) {
    return runOnRaw(this, key, args, true);
  };
}

const STRINGIFIERS = ['join', 'toString', 'toLocaleString'] as const;

// Track iteration and run on raw to ensure dependency registration
for (const key of STRINGIFIERS) {
  methodIntercepts[key] = function (this: any[], ...args: any[]) {
    const raw = trackedRaw(this);
    return raw[key](...args);
  };
}
