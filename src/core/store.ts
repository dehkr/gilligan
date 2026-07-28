import { dispatch } from '../dom/events';
import { runRequestLifecycle } from '../net/lifecycle';
import { request } from '../net/request';
import { reactive, seedPropagation, trackDirty } from '../reactivity/reactive';
import type {
  DirectiveSlug,
  FetchConfig,
  LifecycleEvent,
  RouseRequest,
  RouseResponse,
  StoreSyncBeforeDetail,
  StoreSyncDetail,
  StoreSyncRollbackDetail,
  StoreSyncSkippedDetail,
  VoidFn,
} from '../types';
import type { RouseApp } from './app';
import { getDirectiveValue } from './attributes';
import { type HttpMethod, type PatchAction, STORE_PREFIX } from './constants';
import { fail, warn } from './diagnostics';
import { parseDataSourcePath } from './parser';
import { getNestedVal, getPathRoot, setNestedVal } from './path';
import { clone, deepEqual, patchState } from './state';

export interface StoreStatus {
  loading: false | 'push' | 'pull';
  error: string | null;
  lastSync: number;
  dirty: Record<string, boolean>;
}

export interface StoreTarget {
  storeName: string;
  nestedPath: string;
}

export type RouseStore<T extends object = any> = T & {
  readonly __status: StoreStatus;
};

export interface SyncConfig {
  url: string;
  pushMethod?: HttpMethod;
  pullMethod?: HttpMethod;
  action?: PatchAction;
  rollbackOnError?: boolean;
}

export interface StoreRequestOptions {
  url?: string;
  method?: HttpMethod;
  action?: PatchAction;
  overrides?: Partial<RouseRequest>;
  nestedPath?: string;
  rollbackOnError?: boolean;
  triggerEl?: Element;
}

/**
 * Returns the nested slice at `path`, or the whole object when no path is given.
 */
function sliceAt(obj: any, path?: string) {
  return path ? getNestedVal(obj, path) : obj;
}

/**
 * Resolves a push/pull subject into a store name and optional nested path.
 * A `null` subject means self-target, which is valid only on a <script> element
 * with the `rz-store` directive present.
 */
export function resolveTarget(
  el: Element,
  slug: Extract<DirectiveSlug, 'push' | 'pull'>,
  subject: string | null,
): StoreTarget | null {
  if (subject) {
    if (!subject.startsWith(STORE_PREFIX)) {
      __DEV__ &&
        warn(
          `rz-${slug}: target '${subject}' must be a store reference (e.g., '@store').`,
        );
      return null;
    }
    const { source: storeName, nestedPath } = parseDataSourcePath(subject);
    if (!storeName) {
      __DEV__ && warn(`rz-${slug}: invalid store reference '${subject}'.`);
      return null;
    }
    return { storeName, nestedPath };
  }

  // Reference the `rz-store` value if `null`. Specific to <script> elements.
  const selfName = getDirectiveValue(el, 'store')?.trim();
  if (!selfName) {
    __DEV__ &&
      warn(
        `rz-${slug}: missing store reference. To self-reference a store on a <script> element, add rz-store as well.`,
        el,
      );
    return null;
  }
  return { storeName: selfName, nestedPath: '' };
}

/**
 * Resolves a store reference to a string value intended for use as a URL.
 */
export function resolveStoreUrl(ref: string, stores: StoreManager): string | null {
  if (!ref.startsWith(STORE_PREFIX)) return ref;

  const { source: storeName, nestedPath } = parseDataSourcePath(ref);
  const storeData = stores.get(storeName);

  const value = getNestedVal(storeData, nestedPath);

  if (!value || typeof value !== 'string' || !value.trim()) {
    __DEV__ && warn(`Invalid URL. '${ref}' does not resolve to a string.`);
    return null;
  }

  return value;
}

/**
 * The central manager for all reactive stores and their network logic.
 * Instantiated once per RouseApp to ensure isolation.
 */
export class StoreManager {
  private app: RouseApp;

  private _data = new Map<string, any>();
  private _status = new Map<string, StoreStatus>();
  private _configs = new Map<string, SyncConfig>();
  private _initial = new Map<string, any>();
  private _lastGood = new Map<string, any>();
  private _activeReqs = new Map<string, symbol>();
  private _elements = new Map<string, Element>();
  private _mutateListeners = new Map<string, Set<VoidFn>>();
  private _pendingMutates = new Set<string>();
  private _isPatching = false;

  constructor(app: RouseApp) {
    this.app = app;
  }

  private _createStatus(): StoreStatus {
    return reactive({
      loading: false,
      error: null,
      lastSync: 0,
      dirty: {},
    });
  }

  _setConfig(id: string, partial?: Partial<SyncConfig>) {
    const existing = this._configs.get(id) || { url: '' };
    this._configs.set(id, { ...existing, ...partial });
  }

  private _register(
    id: string,
    state: object,
    programmaticConfig?: Partial<SyncConfig>,
    el?: Element,
  ) {
    const status = this._createStatus();
    this._status.set(id, status);

    // Expose __status invisibly
    Object.defineProperty(state, '__status', {
      value: status,
      enumerable: false,
      configurable: true,
      writable: false,
    });

    const proxyState = reactive(state);
    this._data.set(id, proxyState);
    this._initial.set(id, clone(state));

    trackDirty(proxyState, (rootKey: string) => {
      if (this._isPatching) return;
      this._withPatchGuard(() => {
        status.dirty[rootKey] = true;
      });
      this._scheduleMutate(id);
    });

    if (programmaticConfig) {
      this._setConfig(id, programmaticConfig);
    }

    if (el) {
      this._elements.set(id, el);
    }
  }

  private _getStore(id: string) {
    const data = this._data.get(id);
    const status = this._status.get(id);
    const config = this._configs.get(id);

    if (!data || !status) {
      __DEV__ && warn(`Store '${id}' not found.`);
      return undefined;
    }

    return { data, status, config };
  }

  private _updateLastGood(storeName: string, data: any) {
    this._lastGood.set(storeName, clone(data));
  }

  private _dispatchSyncEvent(
    eventName: LifecycleEvent,
    detail:
      | StoreSyncBeforeDetail
      | StoreSyncDetail
      | StoreSyncRollbackDetail
      | StoreSyncSkippedDetail,
    storeName: string,
    options?: CustomEventInit,
  ) {
    const target = this.elementFor(storeName) || this.app.root;
    return dispatch(target, eventName, detail, options);
  }

  /**
   * Internal unified request handler for push and pull operations.
   */
  private async _request(
    id: string,
    operation: 'push' | 'pull',
    manualConfig?: StoreRequestOptions,
  ) {
    const store = this._getStore(id);
    if (!store) return;

    const { data, status, config } = store;
    const overrides = manualConfig?.overrides ?? {};

    const rawUrl = manualConfig?.url || overrides.url || config?.url;
    const url = rawUrl ? resolveStoreUrl(rawUrl, this) : null;

    const defaultMethod = operation === 'push' ? 'POST' : 'GET';
    const storeMethod = operation === 'push' ? config?.pushMethod : config?.pullMethod;
    const method =
      manualConfig?.method || overrides.method || storeMethod || defaultMethod;

    if (!url) {
      __DEV__ && warn(`Cannot ${operation} store '${id}': URL not configured.`);
      return;
    }

    const requestOptions: RouseRequest = {
      ...overrides,
      method,
      abortKey: overrides.abortKey ?? `${operation}_${id}`,
    };

    // Body for push: full data, or a nested slice if nestedPath is provided
    if (operation === 'push') {
      requestOptions.body = sliceAt(data, manualConfig?.nestedPath);
    }

    // Request-axis events fire from the trigger element; destination-axis
    // (rz:store:sync:*) events keep firing from elementFor(id) ?? root.
    const firingEl = manualConfig?.triggerEl ?? this.elementFor(id) ?? this.app.root;

    await runRequestLifecycle({
      el: firingEl,
      prefix: operation === 'push' ? 'rz:push' : 'rz:pull',
      configDetail: {
        storeName: id,
        config: requestOptions,
        url,
        method,
      },
      lifecycleDetail: {
        storeName: id,
        config: requestOptions,
      },
      terminalDetail: (result) => ({
        storeName: id,
        result,
      }),
      run: async (handle) => {
        const reqToken = Symbol();
        this._activeReqs.set(id, reqToken);

        const snapshot = clone(data);
        status.loading = operation;
        status.error = null;

        try {
          const result = await request(url, requestOptions, this.app);
          handle.settle(result);

          if (result.error) {
            if (result.error.status === 'CANCELED') {
              return result;
            }

            status.error = result.error.message;

            const rollbackOnError =
              manualConfig?.rollbackOnError ??
              (requestOptions as FetchConfig).rollbackOnError ??
              config?.rollbackOnError ??
              false;

            if (operation === 'push' && rollbackOnError) {
              this._maybeRollback(
                id,
                data,
                status,
                snapshot,
                manualConfig?.nestedPath,
                result.error,
              );
            }
            return result;
          }

          this._applyServerResponse(
            id,
            operation,
            result,
            data,
            status,
            config,
            snapshot,
            manualConfig,
          );
          return result;
        } finally {
          if (this._activeReqs.get(id) === reqToken) {
            status.loading = false;
            this._activeReqs.delete(id);
          }
        }
      },
    });
  }

  /**
   * Clears dirty flags for keys whose current value matches `reference`: the
   * pushed snapshot on a successful sync, or last-good state on rollback.
   */
  private _clearDirtyMatching(
    status: StoreStatus,
    data: any,
    reference: any,
    nestedPath?: string,
  ) {
    const rootKey = getPathRoot(nestedPath);
    const keys = rootKey ? [rootKey] : Object.keys(reference);
    for (const key of keys) {
      if (Object.hasOwn(reference, key) && deepEqual(data[key], reference[key])) {
        delete status.dirty[key];
      }
    }
  }

  private _applyServerResponse(
    storeName: string,
    operation: 'push' | 'pull',
    result: RouseResponse,
    data: any,
    status: StoreStatus,
    config: SyncConfig | undefined,
    snapshot: any,
    manualConfig?: StoreRequestOptions,
  ) {
    const action = manualConfig?.action || config?.action || 'replace';
    const nestedPath = manualConfig?.nestedPath;

    // Request-scoped, not response-scoped: a 200 means the data reached the server,
    // so this stands even when the echo below is never applied (mid-flight skip, or
    // a listener cancelling `:before`).
    if (operation === 'push') {
      status.lastSync = Date.now();
      this._clearDirtyMatching(status, data, snapshot, nestedPath);
    }

    const beforeEvent = this._dispatchSyncEvent(
      'rz:store:sync:before',
      { storeName, operation, data, payload: result.data, nestedPath, action },
      storeName,
      { cancelable: true },
    );
    if (beforeEvent.defaultPrevented) return;

    // Whole `result.data`, mutable by listeners (matches the router's deposit path)
    const payload = (beforeEvent.detail as StoreSyncBeforeDetail).payload;

    // Reconcile the response body into the store. On push, how server-owned fields
    // (assigned id, computed/normalized values) return to the client. On pull, the
    // fetched data itself.
    if (payload && typeof payload === 'object') {
      const localSlice = sliceAt(data, nestedPath);
      const snapSlice = sliceAt(snapshot, nestedPath);
      const isMutating = !deepEqual(localSlice, snapSlice);

      // Apply server update if local state is not being mutated during request
      if (!isMutating) {
        if (nestedPath) {
          const incoming = getNestedVal(payload, nestedPath);
          if (incoming !== undefined) {
            this._withPatchGuard(() => {
              const target = getNestedVal(data, nestedPath);
              if (
                action === 'merge' &&
                target &&
                typeof target === 'object' &&
                incoming &&
                typeof incoming === 'object'
              ) {
                patchState(target, incoming, 'merge');
              } else {
                setNestedVal(data, nestedPath, incoming);
              }
            });
          }
        } else {
          this._withPatchGuard(() => patchState(data, payload, action));
        }
      } else {
        // Local state moved mid-flight; keep the edit and skip the echo
        this._dispatchSyncEvent(
          'rz:store:sync:skipped',
          {
            storeName,
            operation,
            localData: localSlice,
            serverData: sliceAt(payload, nestedPath),
            response: result,
            nestedPath,
            action,
          },
          storeName,
        );
        return;
      }
    }

    if (operation === 'pull') {
      status.lastSync = Date.now();
    }

    this._updateLastGood(storeName, data);

    this._dispatchSyncEvent(
      'rz:store:sync',
      { storeName, operation, data, response: result, payload, nestedPath, action },
      storeName,
    );
  }

  /**
   * Marks a store server-synced. Used by the router's deposit path, which is
   * server contact but goes through `update()` (a local-mutation primitive).
   */
  _markSynced(name: string) {
    const status = this._status.get(name);
    if (status) {
      status.lastSync = Date.now();
    }
  }

  private _withPatchGuard(fn: VoidFn) {
    this._isPatching = true;
    try {
      fn();
    } finally {
      this._isPatching = false;
    }
  }

  private _clearAllDirty(storeName: string) {
    const status = this._status.get(storeName);
    if (!status) return;
    for (const key of Object.keys(status.dirty)) {
      delete status.dirty[key];
    }
  }

  private _maybeRollback(
    storeName: string,
    data: any,
    status: StoreStatus,
    snapshot: any,
    nestedPath: string | undefined,
    error: unknown,
  ): boolean {
    const lastGood = this._lastGood.get(storeName);
    if (lastGood === undefined) return false;

    // Skip when the user has kept editing during flight
    const localSlice = sliceAt(data, nestedPath);
    const snapSlice = sliceAt(snapshot, nestedPath);
    if (!deepEqual(localSlice, snapSlice)) return false;

    // Skip if data already equals lastGood (avoids firing errant signals)
    const lastGoodSlice = sliceAt(lastGood, nestedPath);
    if (deepEqual(localSlice, lastGoodSlice)) return false;

    const rolledBackTo = clone(sliceAt(lastGood, nestedPath));

    this._withPatchGuard(() => {
      if (nestedPath) {
        setNestedVal(data, nestedPath, rolledBackTo);
      } else {
        patchState(data, rolledBackTo, 'replace');
      }
    });

    this._clearDirtyMatching(status, data, lastGood, nestedPath);

    this._dispatchSyncEvent(
      'rz:store:sync:rollback',
      {
        storeName,
        operation: 'push',
        data,
        rolledBackTo,
        nestedPath,
        error,
        reason: 'push-error',
      },
      storeName,
    );

    return true;
  }

  private _scheduleMutate(name: string) {
    if (!this._mutateListeners.has(name)) return;
    const wasEmpty = this._pendingMutates.size === 0;
    this._pendingMutates.add(name);
    if (wasEmpty) {
      queueMicrotask(() => {
        const toNotify = [...this._pendingMutates];
        this._pendingMutates.clear();
        for (const n of toNotify) {
          const listeners = this._mutateListeners.get(n);
          if (listeners) {
            for (const cb of listeners) cb();
          }
        }
      });
    }
  }

  /**
   * Listens for user-driven mutations to the store. Returns a cleanup function.
   */
  onEdit(name: string, callback: () => void): VoidFn {
    let listeners = this._mutateListeners.get(name);
    if (!listeners) {
      listeners = new Set();
      this._mutateListeners.set(name, listeners);
      // Seed lazy tracker propagation across the initial tree
      const data = this._data.get(name);
      if (data) seedPropagation(data);
    }
    listeners.add(callback);
    return () => {
      listeners.delete(callback);
      if (listeners.size === 0 && this._mutateListeners.get(name) === listeners) {
        this._mutateListeners.delete(name);
      }
    };
  }

  /**
   * Retrieves the source `<script rz-store>` element for a registered store.
   */
  elementFor(name: string): Element | undefined {
    return this._elements.get(name);
  }

  /**
   * Returns an iterable object containing every `<script rz-store>` element
   * registered in the store manager.
   */
  elements(): Iterable<Element> {
    return this._elements.values();
  }

  /**
   * Registers a new store and returns its reactive proxy.
   */
  create<T extends object = any>(
    name: string,
    state: T,
    config?: Partial<SyncConfig>,
    el?: Element,
  ): RouseStore<T> {
    if (this._data.has(name)) {
      fail(`A store named '${name}' already exists.`);
    }

    this._register(name, state, config, el);
    this._updateLastGood(name, state);

    return this._data.get(name);
  }

  /**
   * Overwrites store state, clears dirty flags, resets the store's initial data
   * snapshot, and pulls the snapshot of the most recently server-confirmed state.
   */
  update<T extends object = any>(
    name: string,
    state: object,
    config?: Partial<SyncConfig>,
  ): RouseStore<T> {
    if (!this._data.has(name)) {
      fail(`Store '${name}' does not exist.`);
    }

    const action = config?.action || this._configs.get(name)?.action || 'replace';

    this._withPatchGuard(() => patchState(this._data.get(name), state, action));
    this._initial.set(name, clone(state));
    this._updateLastGood(name, state);
    this._clearAllDirty(name);

    if (config) {
      this._setConfig(name, config);
    }

    return this._data.get(name);
  }

  /**
   * Returns the reactive proxy for a store, or `undefined`.
   */
  get<T extends object = any>(name: string): RouseStore<T> | undefined {
    return this._data.get(name);
  }

  /**
   * Returns a deep-cloned non-reactive copy of the store's current data.
   */
  snapshot<T = any>(name: string): T | undefined {
    const data = this._data.get(name);
    return data ? clone(data) : undefined;
  }

  /**
   * Returns `true` if a store with the provided name exists.
   */
  has(name: string): boolean {
    return this._data.has(name);
  }

  /**
   * Returns the status object for a store, or `undefined`. Available store
   * status properties are `loading`, `error`, `lastSync`, and `dirty`.
   */
  status(name: string): StoreStatus | undefined {
    return this._status.get(name);
  }

  /**
   * Patches `SyncConfig` for a store. Warns if the store is missing.
   */
  config(name: string, config: Partial<SyncConfig>) {
    if (!this.has(name)) {
      __DEV__ && warn(`Cannot configure store '${name}': store not found.`);
      return;
    }
    this._setConfig(name, config);
  }

  /**
   * Triggers a manual store push with optional request overrides.
   */
  async push(name: string, config?: StoreRequestOptions): Promise<void> {
    return this._request(name, 'push', config);
  }

  /**
   * Pulls fresh store data from the server, unless a push is currently in flight.
   */
  async pull(name: string, config?: StoreRequestOptions): Promise<void> {
    if (this.status(name)?.loading === 'push') return;
    return this._request(name, 'pull', config);
  }

  /**
   * Reverts a store to its initial state, clears dirty flags, and pulls
   * the snapshot of the most recently server-confirmed state.
   */
  reset(name: string) {
    const data = this._data.get(name);
    const initial = this._initial.get(name);

    if (!data) {
      __DEV__ && warn(`Cannot reset store '${name}': store not found.`);
      return;
    }

    if (!initial) {
      __DEV__ && warn(`Cannot reset store '${name}': no initial state cached.`);
      return;
    }

    this._withPatchGuard(() => patchState(data, clone(initial), 'replace'));
    this._updateLastGood(name, data);
    this._clearAllDirty(name);
  }

  /**
   * Drops all per-store state from the manager. Existing references to the proxy
   * keep working but desync. Intended for tear-down of dynamically-created stores.
   */
  remove(name: string) {
    this._data.delete(name);
    this._status.delete(name);
    this._configs.delete(name);
    this._elements.delete(name);
    this._initial.delete(name);
    this._lastGood.delete(name);
    this._activeReqs.delete(name);
    this._mutateListeners.delete(name);
    this._pendingMutates.delete(name);
  }
}
