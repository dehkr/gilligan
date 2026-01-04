import { reactive } from './reactivity';

/**
 * Creates a reactive store to enable shared state.
 * 
 * @param initialState The initial object to make reactive.
 */
export function createStore<T extends object>(initialState: T): T {
  return reactive(initialState);
}
