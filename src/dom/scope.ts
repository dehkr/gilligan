import { effectScope } from 'alien-signals';
import type { RouseApp } from '../core/app';
import { STORE_PREFIX } from '../core/constants';
import { fail, warn } from '../core/diagnostics';
import { resolveInjection } from '../core/injection';
import { rzScope, rzWake } from '../directives';
import { withMethodAliases } from '../net/request';
import type { ScopeCtx, ScopeSetup, VoidFn } from '../types';
import { bindScope } from './binder';
import { attachWakeStrategies, dispatch, on } from './events';
import { swap } from './swapper';

export const IS_SCOPE: unique symbol = Symbol('rz_is_scope');

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
  let isAlias = false;

  // This enables alias scopes (context aliasing for stores). Makes a store,
  // or a nested slice of one, the scope instance directly.
  if (scopeName.startsWith(STORE_PREFIX)) {
    isAlias = true;
    setup = () => {
      // Fetch the live proxy. Must be an object.
      const storeData = resolveInjection(scopeName, app.stores, true);
      return storeData || {};
    };
  } else if (scopeName === '') {
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

  attachWakeStrategies(el, strategies, () => {
    // Data can't be passed to an alias so skip `resolveInjection` in that case
    const data = isAlias ? {} : resolveInjection(rawPayload, app?.stores) || {};
    initScopeInstance(el, app, setup, data, { isAlias });
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
  options: { isAlias?: boolean } = {},
) {
  if (instanceMap.has(el)) return;
  instanceMap.set(el, createScope(el, app, setup, params, options));
}

/**
 * Tears down the instance on `el`, firing `rz:scope:destroy` first.
 */
export function destroyInstance(el: HTMLElement) {
  const inst = instanceMap.get(el);
  if (inst) {
    dispatch(el, 'rz:scope:destroy');
    // Trigger `disconnect()` and cleanup
    inst._destroy();
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
  options: { isAlias?: boolean } = {},
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

  // Inject abort signal to avoid background request if scope is destroyed.
  // User can override by adding `signal: undefined`. `keepalive: true` lets a
  // request finish even if the tab closes.
  const scopedFetch = withMethodAliases((resource, options = {}) =>
    app.fetch(resource, {
      target: el,
      signal: abortCtrl.signal,
      swap: false,
      ...options,
    }),
  );

  // Context object passed into the scope setup function
  const context: ScopeCtx = {
    params,
    host: el,
    appRoot: app.root,
    stores: app.stores,
    swap,
    term: abortCtrl.signal,
    fetch: scopedFetch,
    dispatch: (...args: any[]) => {
      // If the first argument is a string, assume target was omitted
      const isImplied = typeof args[0] === 'string';

      const target = isImplied ? el : args[0];
      const name = isImplied ? args[0] : args[1];
      const detail = isImplied ? args[1] : args[2];
      const options = isImplied ? args[2] : args[3];

      return dispatch(target, name, detail, options);
    },
    on: (...args: any[]) => {
      // If the first argument is a string, assume target was omitted
      const isImplied = typeof args[0] === 'string';

      const target = isImplied ? el : args[0];
      const events = isImplied ? args[0] : args[1];
      const callback = isImplied ? args[1] : args[2];
      const customSignal = isImplied ? args[2] : args[3];

      const activeSignal = customSignal
        ? AbortSignal.any([abortCtrl.signal, customSignal]) // Optional custom signal
        : abortCtrl.signal;

      return on(target, events, callback, activeSignal);
    },
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
    const { unbindDom, scan, teardown } = bindScope(
      el,
      instance,
      app,
      options.isAlias === true,
    );
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
