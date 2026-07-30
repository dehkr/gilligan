import {
  rzAttr,
  rzClass,
  rzFetch,
  rzHtml,
  rzModel,
  rzOn,
  rzProp,
  rzPull,
  rzPush,
  rzRender,
  rzStore,
  rzStyle,
  rzText,
} from '../directives';
import {
  mountGlobalBinding,
  registerBoundDirectives,
  teardownGlobalBindings,
  walkBoundElements,
} from '../dom/binder';
import { dispatch, on } from '../dom/events';
import { initObserver } from '../dom/observer';
import { destroyInstance, IS_SCOPE, initScopeElement } from '../dom/scope';
import { initStoreRouter } from '../dom/store-router';
import { initDomRouter } from '../dom/swapper';
import { handleFetch } from '../net/fetch-engine';
import { fallbackResponse } from '../net/response';
import type {
  BoundOn,
  ErrorInterceptor,
  InterceptorPhase,
  RequestInterceptor,
  ResponseInterceptor,
  RouseFetch,
  RouseRequest,
  ScopeSetup,
  VoidFn,
} from '../types';
import { directiveSelector, queryTargets } from './attributes';
import { err, fail, warn } from './diagnostics';
import { ScopeRegistry } from './scope-registry';
import { StoreManager, type SyncConfig } from './store';

export interface RouseConfig {
  /** Element or selector where the app mounts. Defaults to `document.body`. */
  root?: string | HTMLElement;
  /** Prepended to relative URLs in `rz-fetch`, `rz-push`, `rz-pull`, and `{app,ctx}.fetch()`. */
  baseUrl?: string;
  /** Default headers applied to every request. Merged with per-request and directive-level headers; a `null` value removes the header. */
  headers?: Record<string, string | null>;
  /** Standard fetch `credentials` value applied to every request. */
  credentials?: RequestCredentials;
  /** Default scope activation strategy. Overridden by `rz-wake`. */
  wake?: string;
}

interface ResolvedConfig {
  root: HTMLElement;
  baseUrl: string;
  headers: Record<string, string | null>;
  // Left undefined when not configured; fetch()'s native default is 'same-origin'.
  credentials?: RequestCredentials;
  wake: string;
}

const appInstances = new WeakMap<HTMLElement, RouseApp>();

registerBoundDirectives(
  rzAttr,
  rzClass,
  rzHtml,
  rzModel,
  rzOn,
  rzProp,
  rzRender,
  rzStyle,
  rzText,
);

/**
 * A Rouse application instance. Holds the root element, the stores, the
 * registered scopes, the network interceptors, and the `fetch` and `on` helpers.
 *
 * Creating an app touches the DOM only to claim the root; no directives are read
 * until `start()`, so stores and scopes can be registered in any order first.
 * A root hosts one app at a time, and the constructor throws rather than attach
 * a second.
 *
 * @example
 * const app = rouse({ root: '#app', baseUrl: '/api' });
 * app.store('cart', { items: [] });
 * app.scope({ counter, cart });
 * app.start();
 */
export class RouseApp {
  public readonly root: HTMLElement;
  public readonly config: Readonly<ResolvedConfig>;
  public stores: StoreManager;
  public registry: ScopeRegistry;
  public isReady: boolean;
  public fetch: RouseFetch;
  /**
   * Adds an event listener that is auto-removed when the app is destroyed. Listens
   * on `app.root` unless an `EventTarget` is passed first. An optional `AbortSignal`
   * is combined with the app's own. The programmatic twin of `rz-on` with the same
   * trigger sources and modifiers. Safe to call before `app.start()`.
   *
   * @returns A teardown closure that removes the listener early.
   *
   * @example
   * app.on('page-visible', refetch);
   * app.on('click.debounce.300ms', onClick);
   * app.on(window, 'online offline', sync);
   */
  public on: BoundOn;
  public _interceptors: {
    request: Set<RequestInterceptor>;
    response: Set<ResponseInterceptor>;
    error: Set<ErrorInterceptor>;
  };

  private _hasStarted = false;
  private _destroyed = false;
  private _observer?: MutationObserver;
  private _abortController: AbortController;

  /**
   * Resolves the root, marks it with `data-rouse-app`, and wires the stores, scopes,
   * interceptors, and app-lifetime `AbortController`.
   *
   * @throws If the root cannot be found, or already has an app attached.
   */
  constructor(config: RouseConfig = {}) {
    const rootEl =
      typeof config.root === 'string'
        ? (document.querySelector(config.root) as HTMLElement)
        : (config.root ?? document.body);

    if (!rootEl) {
      fail('Root element not found.');
    }

    if (appInstances.has(rootEl)) {
      fail('An app instance is already attached to this element.');
    }

    this.root = rootEl;

    this.config = {
      root: rootEl,
      baseUrl: config.baseUrl ?? '',
      headers: config.headers ?? {},
      credentials: config.credentials,
      wake: config.wake?.trim() || 'ready',
    };

    this._interceptors = {
      request: new Set(),
      response: new Set(),
      error: new Set(),
    };

    this.stores = new StoreManager(this);
    this.registry = new ScopeRegistry();
    this.isReady = false;

    // Mark root so children can find parent app
    this.root.setAttribute('data-rouse-app', '');
    appInstances.set(this.root, this);

    // Bound so `app.fetch(url)` resolves to this instance
    this.fetch = this._fetch.bind(this);

    // App-lifetime signal, created here instead of in `start` so `app.on` can bind
    // before `app.start()` is called. Is aborted in `destroy`.
    this._abortController = new AbortController();

    // A lifecycle-safe listener bound to the app-lifetime signal, auto-removed on `destroy`
    this.on = (...args: any[]): VoidFn => {
      const implied = typeof args[0] === 'string';
      const target = implied ? this.root : args[0];
      const events = implied ? args[0] : args[1];
      const callback = implied ? args[1] : args[2];
      const customSignal = implied ? args[2] : args[3];

      const signal = customSignal
        ? AbortSignal.any([this._abortController.signal, customSignal])
        : this._abortController.signal;

      return on(target, events, callback, signal, this);
    };
  }

  /**
   * Registers scope setup functions by name. `rz-scope="counter"` resolves against
   * the names registered here.
   *
   * Elements are wired as they are scanned, and a name that is not registered before
   * `start()` is skipped with a warning rather than picked up once it arrives.
   *
   * @param nameOrScopes - A scope name, or an object of names mapped to setup functions.
   * @param setup - The setup function. Only needed when the first argument is a name.
   * @returns The app, so calls can be chained.
   * @throws If the registration is not a plain object, or a value is not a function.
   *
   * @example
   * app.scope('counter', counter);
   * // Object shorthand for bulk registration
   * app.scope({ counter, cart });
   */
  scope<P extends Record<string, any>>(name: string, setup: ScopeSetup<P>): this;
  scope(scopes: Record<string, ScopeSetup<any>>): this;
  scope(
    nameOrScopes: string | Record<string, ScopeSetup<any>>,
    setup?: ScopeSetup<any>,
  ): this {
    const map =
      typeof nameOrScopes === 'string' ? { [nameOrScopes]: setup } : nameOrScopes;

    if (!map || typeof map !== 'object' || Array.isArray(map)) {
      fail('Invalid scope registration.');
    }

    for (const [name, fn] of Object.entries(map)) {
      if (typeof fn !== 'function') {
        fail(`Scope '${name}' must be a setup function.`);
      }

      // Brand as validated; registry.register rejects unbranded setups
      (fn as any)[IS_SCOPE] = true;
      this.registry.register(name, fn);
    }

    return this;
  }

  /**
   * Creates a reactive store and returns its data proxy.
   *
   * A store is one flat object. Data, getters, and methods live side by side.
   * Getters are cached as computeds bound to the proxy and must stay pure. Work
   * that needs cleanup belongs in a scope instead.
   *
   * Only plain, JSON-serializable data is synced. Methods and getters are untouched
   * by snapshots, push bodies, `reset()`, and incoming server state.
   *
   * @template T - Shape of the store's data, getters, and methods.
   * @param name - Unique name. Referenced as `@name` in directives.
   * @param data - Initial state. Made reactive, and kept as the snapshot `reset()` restores.
   * @param config - How the store syncs: URL, push and pull methods, patch action, rollback behavior.
   * @returns The store's reactive proxy.
   * @throws If a store of this name already exists.
   *
   * @example
   * const cart = app.store('cart', {
   *   items: [],
   *   get total() {
   *     return this.items.reduce((sum, item) => sum + item.price, 0);
   *   },
   *   clear() {
   *     this.items = [];
   *   },
   * }, { url: '/api/cart' });
   *
   * cart.items.push(item);
   */
  store<T extends object>(name: string, data: T, config?: Partial<SyncConfig>) {
    return this.stores.create<T>(name, data, config);
  }

  /**
   * Registers a network interceptor. Interceptors run in FIFO order and are
   * `await`ed sequentially, so async interceptors block subsequent ones in
   * the same phase.
   *
   * @returns A teardown closure that unregisters the interceptor.
   *
   * @example
   * const remove = app.interceptor('request', (config) => {
   *   config.headers = { ...config.headers, Authorization: `Bearer ${token}` };
   *   return config;
   * });
   * // Later, in a scope's `disconnect()`:
   * remove();
   */
  interceptor(phase: 'request', fn: RequestInterceptor): VoidFn;
  interceptor(phase: 'response', fn: ResponseInterceptor): VoidFn;
  interceptor(phase: 'error', fn: ErrorInterceptor): VoidFn;
  interceptor(phase: InterceptorPhase, fn: any): VoidFn {
    const set = this._interceptors[phase];
    if (!set) {
      fail(
        `Invalid interceptor: '${phase}'. Expected 'request', 'response', or 'error'.`,
      );
    }
    set.add(fn);
    return () => set.delete(fn);
  }

  /**
   * Triggers a Rouse network request.
   *
   * @param resource - The URL to fetch.
   * @param options - Network configuration, including the DOM `target`.
   */
  private async _fetch(resource: string, options: RouseRequest = {}) {
    const targetRef = options.target || this.root;
    let el: Element | null = null;

    if (typeof targetRef === 'string') {
      try {
        el = document.querySelector<HTMLElement>(targetRef);
      } catch {
        // Fails gracefully on invalid selector
      }
    } else {
      el = targetRef;
    }

    if (!el) {
      __DEV__ && err(`Fetch failed. Target element not found.`, targetRef);
      return fallbackResponse(options, 'Target element not found', 'INTERNAL_ERROR');
    }

    options.url = resource;
    return handleFetch(el, this, options);
  }

  /**
   * Brings the app to life: reads the markup under `root`, creates stores, mounts
   * scopes, binds directives, and starts watching for elements added later.
   *
   * Fires `rz:app:start` before reading anything, and `rz:app:ready` on the next
   * animation frame, once the initial bindings have run and `isReady` is true.
   * Calling it a second time, or after `destroy()`, warns and does nothing.
   *
   * @example
   * document.addEventListener('DOMContentLoaded', () => app.start());
   */
  start() {
    if (this._destroyed) {
      __DEV__ &&
        warn(
          `'start()' called on a destroyed app. Ignoring. Create a new instance instead.`,
        );
      return;
    }
    if (this._hasStarted) {
      __DEV__ && warn(`'start()' called multiple times. Ignoring.`);
      return;
    }

    this._hasStarted = true;

    dispatch(this.root, 'rz:app:start', { app: this });

    initDomRouter(this, this._abortController.signal);
    initStoreRouter(this, this._abortController.signal);

    // Scan for store <script> elements to ensure state exists first
    const storeScriptElements = queryTargets(
      this.root,
      `script${directiveSelector('store')}`,
    );
    storeScriptElements.forEach((el) => {
      if (rzStore.validate(el, this)) {
        rzStore.initialize(el, this);
      }
    });

    this._observer = initObserver(this);
    this._observer.observe(this.root, { childList: true, subtree: true });

    const scopes = queryTargets<HTMLElement>(this.root, directiveSelector('scope'));
    scopes.forEach((el) => {
      if (getApp(el, this)) {
        initScopeElement(el, this);
      }
    });

    for (const d of [rzFetch, rzPush, rzPull]) {
      queryTargets(this.root, directiveSelector(d.slug)).forEach((el) => {
        if (getApp(el, this)) {
          d.initialize(el, this);
        }
      });
    }

    if (!this.root.closest(directiveSelector('scope'))) {
      walkBoundElements(this.root, (el) => {
        if (!getApp(el, this)) return;
        mountGlobalBinding(el, this);
      });
    }

    requestAnimationFrame(() => {
      if (this._destroyed) return;
      this.isReady = true;
      dispatch(this.root, 'rz:app:ready', { app: this });
    });
  }

  /**
   * Shuts the app down: stops watching the DOM, unmounts every scope, unbinds
   * every directive, then fires `rz:app:destroy` and aborts the app's signal.
   *
   * This is final. Aborting drops `app.on` listeners and any request still in
   * flight, and `start()` will not run again. Does nothing if the app never
   * started or is already gone.
   */
  destroy() {
    if (!this._hasStarted || this._destroyed) return;
    this._destroyed = true;

    this._observer?.disconnect();

    const scopes = queryTargets<HTMLElement>(this.root, directiveSelector('scope'));
    scopes.forEach(destroyInstance);

    for (const d of [rzFetch, rzPush, rzPull]) {
      queryTargets(this.root, directiveSelector(d.slug)).forEach(d.teardown);
    }
    for (const el of this.stores.elements()) {
      rzStore.teardown(el as HTMLScriptElement);
    }
    teardownGlobalBindings(this.root);

    dispatch(this.root, 'rz:app:destroy', { app: this });

    // Release after the destroy event so app.on('rz:app:destroy') fires and
    // getApp(e.target) still resolves.
    this.root.removeAttribute('data-rouse-app');
    appInstances.delete(this.root);
    this._abortController.abort();
  }
}

/**
 * Finds the app that owns an element by walking up to the nearest app root.
 *
 * Pass `expected` to check if the element exists within a specific app instance.
 *
 * @param el - An element somewhere inside an app root.
 * @param expected - The app the element is required to belong to.
 * @returns The owning app, or `undefined` if there is none or it is not `expected`.
 *
 * @example
 * if (getApp(el, this)) mountGlobalBinding(el, this);
 */
export function getApp(el: Element, expected?: RouseApp): RouseApp | undefined {
  const root = el.closest<HTMLElement>('[data-rouse-app]');
  if (!root) {
    __DEV__ && warn('Element is not inside an app instance.', el);
    return undefined;
  }

  const found = appInstances.get(root);
  if (expected && found !== expected) {
    __DEV__ && warn('Element does not belong to the expected app instance.', el);
    return undefined;
  }

  return found;
}

/**
 * Creates a Rouse app instance. The standard entry point; equivalent
 * to `new RouseApp(config)`.
 *
 * @param config - App-wide configuration, fixed once the app exists.
 * @returns A new app, ready for stores and scopes and waiting on `start()`.
 *
 * @example
 * const app = rouse({ root: '#app' });
 * app.scope('counter', counter);
 * app.start();
 */
export function rouse(config: RouseConfig = {}): RouseApp {
  return new RouseApp(config);
}
