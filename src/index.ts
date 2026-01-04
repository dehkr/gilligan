import { Gilligan } from './gilligan';

// Make available as 'Gilligan' and the shorthand 'gn'
export { Gilligan, Gilligan as gn };

// These are available on gn/Gilligan but providing as named exports for good measure
export { controller } from './controller';
export { createStore } from './store';
export { reactive, effect } from './reactivity';

export type { SetupContext, SetupFn, GilliganEvent, BindableValue } from './types';
