/**
 * Values that can be bound to the DOM via 'data-gn-bind'.
 */
export type BindableValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | Record<string, boolean> // For class bindings
  | Record<string, string>; // For style bindings

/**
 * Callback signature for the global event bus.
 */
export type BusCallback<T = any> = (detail: T) => void;

/**
 * The context object passed into every controller setup function.
 */
export type SetupContext<P = any> = {
  // Root element of the controller instance
  el: HTMLElement;

  // Map of elements marked with 'data-gn-ref=[name]'
  refs: Record<string, HTMLElement>;

  // The parsed JSON configuration from 'data-gn-props'
  props: P;

  // Helper to dispatch a CustomEvent bubbling up from this controller's root element
  dispatch: (name: string, detail?: any) => CustomEvent;
};

/**
 * The definition of a setup function.
 */
export type SetupFn<P = any, API = Record<string, any>> = (ctx: SetupContext<P>) => API;

/**
 * Extended Event type for events handled by 'data-gn-on'.
 * The framework injects the specific element that triggered the listener.
 * 
 * @template E - The type of the element (e.g. HTMLInputElement).
 * @template D - The type of event.detail (data payload).
 */
export interface GilliganEvent<E = HTMLElement, D = any> extends CustomEvent<D> {
  el: E;
}
