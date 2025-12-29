import { reactive } from './reactivity';

export function createStore<T extends object>(initialState: T): T {
  return reactive(initialState);
}
