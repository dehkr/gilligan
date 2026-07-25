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
import { withMethodAliases } from '../net/request';
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

// Wire the bound directives the binder will scan for
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
 * Core class for instantiating Rouse app instances.
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

    // Bound + alias-decorated so `app.fetch.post(url)` resolves to this instance
    this.fetch = withMethodAliases(this._fetch.bind(this));

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
   * Registers one or multiple scopes to the application.
   *
   * @example
   * // Single registration
   * app.scope('counter', counter);
   * app.scope('cart', cart);
   *
   * @example
   * // Object shorthand for bulk registration
   * app.scope({ counter, cart });
   *
   * @param nameOrScopes - Either the unique string name of a scope, or an object mapping names to setup functions.
   * @param setup - The setup function (only required when the first argument is a string).
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
   * Creates a new reactive store.
   */
  store<T extends object>(name: string, state: T, config?: Partial<SyncConfig>) {
    return this.stores.create<T>(name, state, config);
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
   *
   * // Later, e.g. in a scope's disconnect():
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
   * Trigger a Rouse network request.
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
   * Starts the Rouse app instance. Sets up the global fetch handler.
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
      this.isReady = true;
      dispatch(this.root, 'rz:app:ready', { app: this });
    });
  }

  /**
   * Completely tears down the app instance, unmounts scopes,
   * stops timers, and frees memory.
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
    this._abortController.abort();
  }
}

/**
 * Finds the parent app instance for any child element.
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
 * Main entry point for the framework.
 */
export function rouse(config: RouseConfig = {}): RouseApp {
  return new RouseApp(config);
}
