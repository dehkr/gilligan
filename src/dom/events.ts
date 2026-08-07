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
  /**
   * Suppress native navigation (anchor clicks, form submits) before the action runs.
   * Defaults to `true`: a directive on an anchor or form is taking the interaction
   * over. `app.on`/`ctx.on` pass `false`: a programmatic listener observes an element,
   * it doesn't take control of it. Those callers opt in with the `prevent` modifier.
   */
  suppressNavigation?: boolean;
}

export type TriggerSourceHandler = (ctx: TriggerContext) => VoidFn | null;

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
 * Attaches a DOM event listener, applying the parsed modifiers: listener options,
 * event-argument filters, and target resolution. Execution timing is not applied here;
 * `dispatchTrigger`, its only caller, wraps the callback before calling in.
 *
 * `once` is enforced manually rather than natively so a modifier-filtered event doesn't
 * consume the listener. Trigger sources get their own via `attachTriggerSource`.
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
 * the trigger-source registry (via `dispatchTrigger` or `attachListener`),
 * and returns a single aggregate cleanup that tears them all down.
 *
 * Backs `app.on` and `ctx.on`, which bind it to an app- or scope-lifetime
 * abort signal. The optional `app` is threaded to the trigger engine so
 * trigger sources like `ready` resolve the owning instance without a
 * DOM lookup (and work on non-element targets such as `window`).
 *
 * @example
 * ctx.on(el, 'click|debounce.500ms', handleClick);
 * app.on('page-visible online', sync);
 */
export function on<N extends string>(
  target: EventTarget,
  events: N,
  callback: (
    ev: CustomEvent<N extends keyof LifecycleEventMap ? LifecycleEventMap[N] : any>,
  ) => void,
  abortSignal?: AbortSignal,
  app?: RouseApp,
): VoidFn;

export function on(
  target: EventTarget,
  events: string,
  callback: (ev: CustomEvent<any>) => void,
  abortSignal?: AbortSignal,
  app?: RouseApp,
): VoidFn {
  // Bail before attaching on an already-aborted signal. Otherwise the
  // listeners attach and the abort event never fires to remove them.
  if (abortSignal?.aborted) return () => {};

  const triggers = parseTriggers(events);
  if (triggers.length === 0) return () => {};

  const cleanups: Array<VoidFn> = [];

  for (const trigger of triggers) {
    const cleanup = dispatchTrigger(trigger, {
      el: target as Element,
      app,
      action: callback as ActionFn,
      suppressNavigation: false,
    });
    if (cleanup) {
      cleanups.push(cleanup);
    }
  }

  if (abortSignal) {
    abortSignal.addEventListener(
      'abort',
      () => {
        for (const fn of cleanups) fn();
      },
      { once: true },
    );
  }

  return () => {
    for (const fn of cleanups) fn();
  };
}

/**
 * Routes a single trigger to its handler. Trigger sources go through the
 * `triggerSources` registry. Standard DOM events fall through to `attachListener`.
 *
 * Timed execution (debounce/throttle) is applied here once, before dispatch, so
 * trigger sources and DOM events both receive timed actions. The returned cleanup
 * also cancels any pending timed calls.
 *
 * Native navigation is suppressed for form submits and anchor clicks unless the
 * caller opts out with `suppressNavigation: false`, which `app.on`/`ctx.on` do.
 *
 * @returns Cleanup function, or `null` if the trigger has no teardown.
 */
export function dispatchTrigger(
  trigger: TriggerDef,
  base: Omit<TriggerContext, 'modifiers'>,
): VoidFn | null {
  const timed = applyTiming(base.action, trigger.modifiers);
  const suppressNavigation = base.suppressNavigation ?? true;

  const wrapCleanup = (cleanup: VoidFn | null): VoidFn => {
    return () => {
      timed.cancel();
      cleanup?.();
    };
  };

  const handler = triggerSources[trigger.event];
  if (handler) {
    const cleanup = attachTriggerSource(handler, {
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
      if (suppressNavigation && isNativeNavigation(base.el, e)) {
        e.preventDefault();
      }
      timed(e);
    },
    trigger.modifiers,
  );

  return wrapCleanup(cleanup);
}

/**
 * Runs a trigger source with `once` enforced centrally, so no source hand-rolls it.
 * Teardown runs before the action, matching `attachListener`, so a throwing action
 * still detaches.
 *
 * A source can fire while it's still attaching (an already-matching `media` query,
 * an already-loaded page) before its teardown exists, so it checks post-attach.
 */
function attachTriggerSource(
  handler: TriggerSourceHandler,
  ctx: TriggerContext,
): VoidFn | null {
  if (!ctx.modifiers.includes('once')) return handler(ctx);

  const action = ctx.action;
  let cleanup: VoidFn | null = null;
  let fired = false;

  ctx.action = (e?: Event) => {
    if (fired) return;
    fired = true;
    cleanup?.();
    action(e);
  };

  cleanup = handler(ctx);
  if (fired) cleanup?.();

  return cleanup;
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
  app: RouseApp,
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
      for (const cleanup of cleanups) cleanup();
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

    const cleanup = dispatchTrigger(trigger, { el, action, app });
    if (cleanup) {
      cleanups.push(cleanup);
    }
  }

  // Return a master cleanup in case the element is destroyed before waking
  return () => {
    if (!isAwake) {
      for (const cleanup of cleanups) cleanup();
    }
  };
}

/**
 * Universal trigger sources available to directives and `app.on`/`ctx.on`.
 * Store-specific sources (`edit`) stay inline in `rz-push`.
 */
export const triggerSources: Record<string, TriggerSourceHandler> = {
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

  /** Opts the directive out of all auto-binding (explicit no-op). */
  none: () => null,

  /**
   * Fires when all assets (images, etc.) are fully loaded or immediately if the
   * page has already loaded.
   */
  'page-loaded': ({ action }) => {
    if (document.readyState === 'complete') {
      action();
      return null;
    }
    return attachWindowEvent('load', action);
  },

  /** Fires when the document becomes visible (e.g., tab switch, maximize). */
  'page-visible': ({ action }) => attachVisibilityChange('visible', action),

  /** Fires when the document becomes hidden (e.g., tab switch, minimize). */
  'page-hidden': ({ action }) => attachVisibilityChange('hidden', action),

  /** Fires when the browser gains access to the network. */
  'network-online': ({ action }) => attachWindowEvent('online', action),

  /** Fires when the browser loses access to the network. */
  'network-offline': ({ action }) => attachWindowEvent('offline', action),

  /** Fires once after a specified period (`setTimeout`). */
  timeout: (ctx) => attachTimingSource('timeout', ctx),

  /** Repeating timer (`setInterval`). */
  interval: (ctx) => attachTimingSource('interval', ctx),

  /** Listens to a media query. */
  media: ({ el, modifiers, action }) => {
    const query = modifiers.find((m) => m.startsWith('(') && m.endsWith(')'));

    if (!query) {
      __DEV__ && warn(`The 'media' event requires a query modifier in parentheses.`, el);
      return null;
    }

    const mql = window.matchMedia(query);
    if (mql.matches) action();

    const changeHandler = (e: MediaQueryListEvent) => {
      if (e.matches) action();
    };

    mql.addEventListener('change', changeHandler);
    return () => mql.removeEventListener('change', changeHandler);
  },

  /** Element intersection with the viewport. */
  intersect: ({ el, action }) => {
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        action();
        break;
      }
    });

    observer.observe(el);
    return () => observer.disconnect();
  },

  /**
   * Fires on pointer or focus interaction with the element. `pointerover` covers
   * mouse, touch, and pen. `focusin` covers keyboard.
   */
  interact: ({ el, action }) => {
    const events = ['pointerover', 'focusin'];

    for (const evt of events) {
      el.addEventListener(evt, action, { passive: true });
    }

    return () => {
      for (const evt of events) {
        el.removeEventListener(evt, action);
      }
    };
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
 * Helper for the `timeout` and `interval` trigger sources.
 */
function attachTimingSource(type: 'timeout' | 'interval', ctx: TriggerContext) {
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
function attachWindowEvent(event: string, action: ActionFn): VoidFn {
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
