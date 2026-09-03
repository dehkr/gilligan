import type { LifecycleEventMap } from '../types';

/**
 * Dispatches a custom event from an element.
 *
 * @param options - Allows overriding cancelable/bubbles
 */
export function dispatch<N extends string>(
  el: EventTarget,
  name: N,
  detail?: N extends keyof LifecycleEventMap ? LifecycleEventMap[N] : any,
  options?: CustomEventInit,
): CustomEvent<N extends keyof LifecycleEventMap ? LifecycleEventMap[N] : any>;

export function dispatch(
  el: EventTarget,
  name: string,
  detail: any = {},
  options: CustomEventInit = {},
): CustomEvent {
  const event = new CustomEvent(name, {
    bubbles: true,
    cancelable: false,
    ...options,
    detail,
  });
  el.dispatchEvent(event);

  return event;
}
