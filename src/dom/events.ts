import { getApp, type RouseApp } from '../core/app';
import { warn } from '../core/diagnostics';
import { isNativeNavigation } from '../core/is';
import { parseTriggers } from '../core/parser';
import { applyTiming, isTimeModifier, parseTime } from '../core/timing';
import type { ActionFn, LifecycleEventMap, TriggerDef, VoidFn } from '../types';
import { applyModifiers, getListenerOptions, resolveListenerTarget } from './modifiers';

export interface TriggerContext {
  el: Element;
  app?: RouseApp;
  modifiers: string[];
  action: ActionFn;
}

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

/**
 * Attaches a DOM event listener with modifier handling:
 *
 * - Listener options (`capture`, `passive`) via `getListenerOptions`
 * - Event-arg modifiers (`prevent`, `stop`, `self`, key filters) via `applyModifiers`
 * - Listener target resolution (`window`, `document`, `root`, `outside`) via `resolveListenerTarget`
 * - `once` enforced manually after the filters pass, so a filtered-out event doesn't consume the listener
 *
 * Does not apply execution timing (debounce/throttle). Most callers should use the
 * public `on()` facade or `dispatchTrigger` instead. This is the primitive both build on.
 *
 * @returns Cleanup function that removes the listener.
 */
function attachListener<D = any>(
  el: EventTarget,
  name: string,
  callback: (ev: CustomEvent<D>) => void,
  modifiers: string[] = [],
): VoidFn {
  const options = getListenerOptions(modifiers);
  const listener = (e: Event) => {
    if (!applyModifiers(e, el, modifiers)) return;

    // Native `once` would consume the listener on filtered-out events,
    // so removal happens here, after the modifiers pass.
    if (options.once) cleanup();
    callback(e as CustomEvent<D>);
  };

  const target = resolveListenerTarget(el as Element, modifiers);
  const cleanup = () => {
    target.removeEventListener(name, listener, options.capture);
  };

  target.addEventListener(name, listener, {
    capture: options.capture,
    passive: options.passive,
  });

  return cleanup;
}

/**
 * Parses a multi-event + modifier string, dispatches each trigger through
 * the synthetic-event registry (via `dispatchTrigger` or `attachListener`),
 * and returns a single aggregate cleanup that tears them all down.
 *
 * Backs `ctx.on` for scopes and is also exported for non-scope
 * code that needs the same trigger semantics as the declarative directives.
 *
 * @example
 * on(el, 'click.debounce.500ms', handleClick);
 * on(el, 'page-visible online', refetch);
 */
export function on<N extends string>(
  target: EventTarget,
  events: N,
  callback: (
    ev: CustomEvent<N extends keyof LifecycleEventMap ? LifecycleEventMap[N] : any>,
  ) => void,
  abortSignal?: AbortSignal,
): VoidFn;

export function on(
  target: EventTarget,
  events: string,
  callback: (ev: CustomEvent<any>) => void,
  abortSignal?: AbortSignal,
): VoidFn {
  const triggers = parseTriggers(events);
  if (triggers.length === 0) return () => {};

  const cleanups: Array<VoidFn> = [];

  for (const trigger of triggers) {
    const cleanup = dispatchTrigger(trigger, {
      el: target as Element,
      app: undefined,
      action: callback as ActionFn,
    });
    if (cleanup) cleanups.push(cleanup);
  }

  if (abortSignal) {
    abortSignal.addEventListener('abort', () => cleanups.forEach((fn) => fn()), {
      once: true,
    });
  }

  return () => cleanups.forEach((fn) => fn());
}

/**
 * Routes a single trigger to its handler. Synthetic events (`interval`,
 * `visible`, `online`, etc.) go through the `syntheticEvents` registry.
 * Standard DOM events fall through to `attachListener`.
 *
 * Timed execution (debounce/throttle) is applied here once, before
 * dispatch, so synthetic and DOM events both receive timed actions.
 * The returned cleanup also cancels any pending timed calls.
 *
 * Native navigation is suppressed for form submits and anchor clicks
 * via `isNativeNavigation`.
 *
 * @returns Cleanup function, or `null` if the trigger has no teardown.
 */
export function dispatchTrigger(
  trigger: TriggerDef,
  base: Omit<TriggerContext, 'modifiers'>,
): VoidFn | null {
  const timed = applyTiming(base.action, trigger.modifiers);

  const wrapCleanup = (cleanup: VoidFn | null): VoidFn => {
    return () => {
      timed.cancel();
      cleanup?.();
    };
  };

  const handler = syntheticEvents[trigger.event];
  if (handler) {
    const cleanup = handler({
      ...base,
      modifiers: trigger.modifiers,
      action: timed,
    });

    return wrapCleanup(cleanup);
  }

  const cleanup = attachListener(
    base.el,
    trigger.event,
    (e: Event) => {
      if (isNativeNavigation(base.el, e)) {
        e.preventDefault();
      }
      timed(e);
    },
    trigger.modifiers,
  );

  return wrapCleanup(cleanup);
}

/**
 * Coordinates `rz-wake` activation strategies using the unified event engine.
 * All strategies must be satisfied before `onWake` fires. If no strategies
 * are provided it fires immediately.
 *
 * @param el - The scope element awaiting activation.
 * @param triggers - Parsed TriggerDef array from `parseTriggers`.
 * @param onWake - Invoked once when all strategies have been satisfied.
 * @returns A master cleanup function to abort wake strategies if the element unmounts early.
 */
export function attachWakeStrategies(
  el: Element,
  triggers: TriggerDef[],
  onWake: VoidFn,
): VoidFn {
  let pending = triggers.length;
  if (pending === 0) {
    onWake();
    return () => {};
  }

  let isAwake = false;
  const cleanups: VoidFn[] = [];

  // Wake triggers only when all conditions are satisfied (AND logic)
  const satisfy = () => {
    if (isAwake) return;
    pending--;

    if (pending === 0) {
      isAwake = true;
      cleanups.forEach((cleanup) => cleanup());
      onWake();
    }
  };

  for (const trigger of triggers) {
    let satisfied = false;

    const action = () => {
      if (satisfied) return;
      satisfied = true;
      satisfy();
    };

    const cleanup = dispatchTrigger(trigger, { el, action, app: undefined });
    if (cleanup) cleanups.push(cleanup);
  }

  // Return a master cleanup in case the element is destroyed before waking
  return () => {
    if (!isAwake) {
      cleanups.forEach((cleanup) => cleanup());
    }
  };
}

export type SyntheticEventHandler = (ctx: TriggerContext) => VoidFn | null;

/**
 * Universal synthetic events available to directives and `on`.
 * Store-specific events (`edit`) stay inline in rz-push.
 */
export const syntheticEvents: Record<string, SyntheticEventHandler> = {
  /** Fires when all assets (images, etc.) are fully loaded. */
  load: ({ action }) => {
    if (document.readyState === 'complete') {
      action();
      return null;
    }
    window.addEventListener('load', action, { once: true });
    return () => window.removeEventListener('load', action);
  },

  /** Fires when the RouseApp instance is fully initialized. */
  ready: ({ el, app, action }) => {
    const inst = app || getApp(el);
    if (!inst) return null;
    if (inst.isReady) {
      action();
      return null;
    }
    inst.root.addEventListener('rz:app:ready', action, { once: true });
    return () => inst.root.removeEventListener('rz:app:ready', action);
  },

  /** Fires once after a specified period (`setTimeout`). */
  timeout: (ctx) => attachTimingEvent('timeout', ctx),

  /** Repeating timer (`setInterval`). */
  interval: (ctx) => attachTimingEvent('interval', ctx),

  /** Explicit no-op (opts the directive out of all auto-binding). */
  none: () => null,

  /** Fires when the browser gains access to the network. */
  online: ({ action }) => attachWindowEvent('online', action),

  /** Fires when the browser loses access to the network. */
  offline: ({ action }) => attachWindowEvent('offline', action),

  /** Document visibility (tab switch / minimize). */
  'page-visible': ({ action }) => attachVisibilityChange('visible', action),
  'page-hidden': ({ action }) => attachVisibilityChange('hidden', action),

  /** Listens to a media query. Supports `.once`. */
  media: ({ el, modifiers, action }) => {
    const query = modifiers.find((m) => m.startsWith('(') && m.endsWith(')'));
    const isOnce = modifiers.includes('once');

    if (!query) {
      __DEV__ && warn(`The 'media' event requires a query modifier in parentheses.`, el);
      return null;
    }

    const mql = window.matchMedia(query);
    if (mql.matches) {
      action();
      if (isOnce) return null;
    }

    const changeHandler = (e: MediaQueryListEvent) => {
      if (!e.matches) return;
      action();
      if (isOnce) {
        mql.removeEventListener('change', changeHandler);
      }
    };

    mql.addEventListener('change', changeHandler);
    return () => mql.removeEventListener('change', changeHandler);
  },

  /** Element intersection with the viewport, supports `.once`. */
  intersect: ({ el, modifiers, action }) => {
    const isOnce = modifiers.includes('once');

    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        action();
        if (isOnce) observer.disconnect();
        break;
      }
    });

    observer.observe(el);
    return () => observer.disconnect();
  },

  /** Aggregate proxy for 'mouseover', 'focusin', or 'touchstart'. Supports `.once`. */
  interact: ({ el, modifiers, action }) => {
    const isOnce = modifiers.includes('once');
    const triggers = ['mouseover', 'focusin', 'touchstart'];
    let hasFired = false;

    const handler = (e: Event) => {
      if (isOnce && hasFired) return;
      hasFired = true;
      // Pass the event along so modifiers or the underlying action can use it
      action(e as any);
      if (isOnce) cleanup();
    };

    const cleanup = () => {
      triggers.forEach((evt) => el.removeEventListener(evt, handler));
    };
    triggers.forEach((evt) => el.addEventListener(evt, handler, { passive: true }));

    return cleanup;
  },

  /** window.requestIdleCallback (one-time execution). */
  idle: ({ action }) => {
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(() => action());
      return () => window.cancelIdleCallback(id);
    }

    // Safari fallback
    const id = window.setTimeout(action, 1);
    return () => window.clearTimeout(id);
  },
};

/**
 * Helper for the `timeout` and `interval` synthetic event functions.
 */
function attachTimingEvent(type: 'timeout' | 'interval', ctx: TriggerContext) {
  const timeModifier = ctx.modifiers.find(isTimeModifier);

  if (!timeModifier) {
    __DEV__ && warn(`Missing timing modifier for '${type}'.`, ctx.el);
    return null;
  }

  const ms = parseTime(timeModifier);
  if (ms <= 0) return null;

  const setup = type === 'timeout' ? window.setTimeout : window.setInterval;
  const clear = type === 'timeout' ? window.clearTimeout : window.clearInterval;

  const id = setup(ctx.action, ms);
  return () => clear(id);
}

/**
 * Subscribes to a window-level event and returns a cleanup that
 * removes the listener.
 */
function attachWindowEvent(event: string, action: VoidFn): VoidFn {
  window.addEventListener(event, action);

  return () => {
    window.removeEventListener(event, action);
  };
}

/**
 * Subscribes to the document `visibilitychange` event, firing `action`
 * when the document transitions to the specified state.
 */
function attachVisibilityChange(state: 'visible' | 'hidden', action: ActionFn): VoidFn {
  const handler = (e: Event) => {
    if (document.visibilityState === state) {
      action(e);
    }
  };

  document.addEventListener('visibilitychange', handler);
  return () => {
    document.removeEventListener('visibilitychange', handler);
  };
}
