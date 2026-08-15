import { effectScope } from 'alien-signals';
import type { RouseApp } from '../core/app';
import { fail, warn } from '../core/diagnostics';
import { resolveInjection } from '../core/injection';
import { rzScope, rzWake } from '../directives';
import type { ScopeCtx, ScopeSetup, VoidFn } from '../types';
import { bindScope } from './binder';
import { attachWakeStrategies, createBoundOn, dispatch } from './events';

export const IS_SCOPE: unique symbol = Symbol(__DEV__ ? 'rz.scope' : '');

type ScopeHandle = ReturnType<typeof createScope>;
const instanceMap = new WeakMap<HTMLElement, ScopeHandle>();

/**
 * Initializes a scope element by parsing its directive, resolving its
 * setup function from the registry, and mounting the reactive instance.
 */
export function initScopeElement(el: HTMLElement, app: RouseApp) {
  const scopeValue = rzScope.getConfig(el);
  if (scopeValue === null) return;

  const { scopeName, rawPayload } = scopeValue;

  let setup: ScopeSetup;

  if (scopeName === '') {
    setup = () => ({});
  } else {
    const scope = app.registry.get(scopeName);
    if (!scope) {
      __DEV__ && warn(`Scope '${scopeName}' is not defined.`);
      return;
    }
    setup = scope;
  }

  const strategies = rzWake.getConfig(el, app);

  attachWakeStrategies(el, app, strategies, () => {
    const data = resolveInjection(rawPayload, app.stores) || {};
    initScopeInstance(el, app, setup, data);
  });
}

/**
 * Initializes a scope instance on a specific element.
 */
function initScopeInstance(
  el: HTMLElement,
  app: RouseApp,
  setup: ScopeSetup,
  params: Record<string, any> = {},
) {
  if (instanceMap.has(el)) return;
  instanceMap.set(el, createScope(el, app, setup, params));
}

/**
 * Tears down the instance on `el`. `_destroy()` fires `rz:scope:disconnect`
 * while unbinding. `rz:scope:destroy` is the final "instance gone" signal,
 * so it dispatches last.
 */
export function destroyInstance(el: HTMLElement) {
  const inst = instanceMap.get(el);
  if (inst) {
    inst._destroy();
    dispatch(el, 'rz:scope:destroy');
    instanceMap.delete(el);
  }
}

/**
 * Routes a newly added node to its owning scope instance for binding.
 */
export function scanScopeNode(el: HTMLElement, newNode: Element) {
  instanceMap.get(el)?._scan(newNode);
}

/**
 * Routes a removed node to its owning scope instance for teardown.
 */
export function teardownScopeNode(el: HTMLElement, removedNode: Element) {
  instanceMap.get(el)?._teardown(removedNode);
}

/**
 * Builds a scope instance on an HTML element. Runs `setup`, dispatches
 * `rz:scope:init`, then binds the subtree. Setup state and DOM bindings each
 * get their own `effectScope`, so bindings tear down before the state they
 * read. Returns an internal handle.
 */
function createScope(
  el: HTMLElement,
  app: RouseApp,
  setup: ScopeSetup,
  params: Record<string, any> = {},
) {
  let instance: any;
  let isDestroyed = false;
  let binding: {
    scan: (el: Element) => void;
    teardown: (el: Element) => void;
  } | null = null;

  const cleanups: VoidFn[] = [];
  const abortCtrl = new AbortController();

  const destroy = () => {
    if (isDestroyed) return;
    isDestroyed = true;
    abortCtrl.abort();
    // Reverse order: DOM bindings must dispose before the state they read
    [...cleanups].reverse().forEach((fn) => fn());
  };

  // Context object passed into the scope setup function
  const context: ScopeCtx = {
    params,
    host: el,
    appRoot: app.root,
    stores: app.stores,
    term: abortCtrl.signal,
    // The scope's signal aborts in-flight requests on destroy. Override with
    // `signal: undefined`, or `keepalive: true` to finish even if the tab closes.
    fetch: (url, options = {}) =>
      app.fetch(url, { signal: abortCtrl.signal, ...options }),
    on: createBoundOn(el, abortCtrl.signal, app),
    // Allows for triggering a scan from inside the scope
    scan: (newNode: Element) => binding?.scan(newNode),
  };

  // `effectScope` for setup state. Wrap effects that belong to the scope instance.
  const stopSetupScope = effectScope(() => {
    instance = setup(context) || {};
  });

  // Block async setup functions since they can't be captured in an `effectScope`,
  // which would result in memory leaks. Scopes should be initialized synchronously,
  // then populated asynchronously (data should be fetched as a side effect).
  if (instance instanceof Promise) {
    stopSetupScope();
    abortCtrl.abort();
    fail('Scope setup must be synchronous. Fetch data as a side effect.');
  }

  cleanups.push(stopSetupScope);

  // State exists but not bound to DOM yet
  dispatch(el, 'rz:scope:init', { context, instance });

  // `effectScope` for bindings. Wrap the logic that connects the reactive state
  // to the DOM. Captures effects created by bindings (text, atts, etc.) so the
  // UI auto updates.
  const stopBindingScope = effectScope(() => {
    const { unbindDom, scan, teardown } = bindScope(el, instance, app);
    binding = { scan, teardown };
    cleanups.push(unbindDom);
  });

  cleanups.push(stopBindingScope);

  return {
    instance,
    _scan: (node: Element) => binding?.scan(node),
    _teardown: (node: Element) => binding?.teardown(node),
    _destroy: destroy,
  };
}
