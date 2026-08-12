import { dispatch } from '../dom/events';
import { type LifecycleHandle, runRequestLifecycle } from '../net/lifecycle';
import { request } from '../net/request';
import { reactive, seedPropagation, trackDirty } from '../reactivity/reactive';
import type {
  DirectiveSlug,
  LifecycleEventMap,
  RouseRequest,
  RouseResponse,
  StoreSyncEvent,
  VoidFn,
} from '../types';
import type { RouseApp } from './app';
import { getDirectiveValue } from './attributes';
import { type HttpMethod, type PatchAction, STORE_PREFIX } from './constants';
import { fail, warn } from './diagnostics';
import { parseStoreRef } from './parser';
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

interface StoreEntry {
  name: string;
  data: any;
  status: StoreStatus;
  initial: any;
  config?: SyncConfig;
  lastGood?: any;
  activeReq?: symbol;
  el?: Element;
  listeners?: Set<VoidFn>;
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
          `rz-${slug}: target '${subject}' must be a store reference (e.g., '@cart').`,
        );
      return null;
    }

    const target = parseStoreRef(subject, slug);
    if (!target) return null;

    const { source: storeName, nestedPath } = target;

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

  const target = parseStoreRef(ref);
  if (!target) return null;

  const storeData = stores.get(target.source);
  const value = getNestedVal(storeData, target.nestedPath);

  if (typeof value !== 'string' || !value.trim()) {
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

  private _stores = new Map<string, StoreEntry>();
  private _pendingMutates = new Set<StoreEntry>();
  private _isPatching = false;

  constructor(app: RouseApp) {
    this.app = app;
  }

  private _setConfig(entry: StoreEntry, partial?: Partial<SyncConfig>) {
    entry.config = { url: '', ...entry.config, ...partial };
  }

  private _register(
    storeName: string,
    state: object,
    programmaticConfig?: Partial<SyncConfig>,
    el?: Element,
  ): StoreEntry {
    const status: StoreStatus = reactive({
      loading: false,
      error: null,
      lastSync: 0,
      dirty: {},
    });
    const proxyState = reactive(state);
    const entry: StoreEntry = {
      name: storeName,
      data: proxyState,
      status,
      initial: clone(state),
    };
    this._stores.set(storeName, entry);

    trackDirty(proxyState, (rootKey: string) => {
      if (this._isPatching) return;
      status.dirty[rootKey] = true;
      this._scheduleMutate(entry);
    });

    if (programmaticConfig) {
      this._setConfig(entry, programmaticConfig);
    }

    if (el) entry.el = el;

    return entry;
  }

  private _getStore(storeName: string) {
    const entry = this._stores.get(storeName);
    __DEV__ && !entry && warn(`Store '${storeName}' not found.`);
    return entry;
  }

  private _updateLastGood(entry: StoreEntry, data: any) {
    entry.lastGood = clone(data);
  }

  private _dispatchSyncEvent<E extends StoreSyncEvent>(
    entry: StoreEntry,
    eventName: E,
    detail: LifecycleEventMap[E],
    options?: CustomEventInit,
  ): CustomEvent<LifecycleEventMap[E]> {
    const target = entry.el || this.app.root;

    return dispatch(target, eventName, detail as any, options) as CustomEvent<
      LifecycleEventMap[E]
    >;
  }

  /**
   * Internal unified request handler for push and pull operations.
   */
  private async _request(
    storeName: string,
    operation: 'push' | 'pull',
    manualConfig?: StoreRequestOptions,
  ) {
    const entry = this._getStore(storeName);
    if (!entry) return;

    const { data, config } = entry;
    const overrides = manualConfig?.overrides ?? {};

    const rawUrl = manualConfig?.url || overrides.url || config?.url;
    const url = rawUrl ? resolveStoreUrl(rawUrl, this) : null;

    const defaultMethod = operation === 'push' ? 'POST' : 'GET';
    const storeMethod = operation === 'push' ? config?.pushMethod : config?.pullMethod;
    const method =
      manualConfig?.method || overrides.method || storeMethod || defaultMethod;

    if (!url) {
      __DEV__ && warn(`Cannot ${operation} store '${storeName}': URL not configured.`);
      return;
    }

    const requestOptions: RouseRequest = {
      ...overrides,
      method,
      abortKey: overrides.abortKey ?? `${operation}_${storeName}`,
      rollbackOnError:
        manualConfig?.rollbackOnError ??
        overrides.rollbackOnError ??
        config?.rollbackOnError ??
        false,
    };

    // Body for push: full data, or a nested slice if nestedPath is provided
    if (operation === 'push') {
      requestOptions.body = sliceAt(data, manualConfig?.nestedPath);
    }

    // Request-axis events fire from the trigger element; destination-axis
    // (rz:store:sync:*) events keep firing from elementFor(storeName) ?? root.
    const firingEl =
      manualConfig?.triggerEl ?? this.elementFor(storeName) ?? this.app.root;

    await runRequestLifecycle({
      el: firingEl,
      root: this.app.root,
      prefix: operation === 'push' ? 'rz:push' : 'rz:pull',
      config: requestOptions,
      configDetail: { storeName, config: requestOptions, url, method },
      lifecycleDetail: { storeName, config: requestOptions },
      terminalDetail: (result) => ({
        storeName,
        result,
      }),
      run: (handle) =>
        this._sendAndApply(entry, operation, url, requestOptions, handle, manualConfig),
    });
  }

  /**
   * Sends the request and applies the outcome to the store: rolls back a failed
   * push when configured, otherwise reconciles the response. Tracks the request so
   * a superseded one leaves `loading` alone when it settles.
   */
  private async _sendAndApply(
    entry: StoreEntry,
    operation: 'push' | 'pull',
    url: string,
    requestOptions: RouseRequest,
    handle: LifecycleHandle,
    manualConfig?: StoreRequestOptions,
  ): Promise<RouseResponse> {
    const { data, status } = entry;

    const reqToken = Symbol('rz.request');
    entry.activeReq = reqToken;

    const snapshot = clone(data);
    status.loading = operation;
    status.error = null;

    try {
      const result = await request(url, requestOptions, this.app);
      handle.settle(result);

      if (result.error) {
        if (result.error.status === 'CANCELED') return result;

        status.error = result.error.message;

        if (operation === 'push' && requestOptions.rollbackOnError) {
          this._maybeRollback(entry, snapshot, manualConfig?.nestedPath, result.error);
        }
        return result;
      }
      this._applyServerResponse(entry, operation, result, snapshot, manualConfig);
      return result;
    } finally {
      if (entry.activeReq === reqToken) {
        status.loading = false;
        entry.activeReq = undefined;
      }
    }
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
    entry: StoreEntry,
    operation: 'push' | 'pull',
    result: RouseResponse,
    snapshot: any,
    manualConfig?: StoreRequestOptions,
  ) {
    const { name: storeName, data, status, config } = entry;

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
      entry,
      'rz:store:sync:before',
      {
        storeName,
        operation,
        data,
        payload: result.data,
        nestedPath,
        action,
      },
      { cancelable: true },
    );
    if (beforeEvent.defaultPrevented) return;

    // Whole `result.data`, mutable by listeners (matches the router's deposit path)
    const payload = beforeEvent.detail.payload;

    // Reconcile the response body into the store. On push, how server-owned fields
    // (assigned id, computed/normalized values) return to the client. On pull, the
    // fetched data itself.
    if (payload && typeof payload === 'object') {
      const localSlice = sliceAt(data, nestedPath);
      const snapSlice = sliceAt(snapshot, nestedPath);

      // Local state moved mid-flight; keep the edit and skip the echo
      if (!deepEqual(localSlice, snapSlice)) {
        this._dispatchSyncEvent(entry, 'rz:store:sync:skipped', {
          storeName,
          operation,
          localData: localSlice,
          serverData: sliceAt(payload, nestedPath),
          response: result,
          nestedPath,
          action,
        });
        return;
      }

      this._patchPayload(data, payload, action, nestedPath);
    }

    if (operation === 'pull') {
      status.lastSync = Date.now();
    }

    this._updateLastGood(entry, data);

    this._dispatchSyncEvent(entry, 'rz:store:sync', {
      storeName,
      operation,
      data,
      response: result,
      payload,
      nestedPath,
      action,
    });
  }

  /**
   * Writes the payload into the store, whole or at `nestedPath`. Merging needs an
   * object on both sides; anything else replaces. A nested path missing from the
   * payload writes nothing.
   */
  private _patchPayload(
    data: any,
    payload: any,
    action: PatchAction,
    nestedPath?: string,
  ) {
    if (!nestedPath) {
      this._withPatchGuard(() => patchState(data, payload, action));
      return;
    }

    const incoming = getNestedVal(payload, nestedPath);
    if (incoming === undefined) return;

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

  /**
   * Marks a store server-synced. Used by the router's deposit path, which is
   * server contact but goes through `update()` (a local-mutation primitive).
   */
  _markSynced(storeName: string) {
    const entry = this._stores.get(storeName);
    if (entry) {
      entry.status.lastSync = Date.now();
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

  private _clearAllDirty(entry: StoreEntry) {
    for (const key of Object.keys(entry.status.dirty)) {
      delete entry.status.dirty[key];
    }
  }

  private _maybeRollback(
    entry: StoreEntry,
    snapshot: any,
    nestedPath: string | undefined,
    error: unknown,
  ): boolean {
    const { name: storeName, data, status, lastGood } = entry;
    if (lastGood === undefined) return false;

    // Skip when the user has kept editing during flight
    const localSlice = sliceAt(data, nestedPath);
    const snapSlice = sliceAt(snapshot, nestedPath);
    if (!deepEqual(localSlice, snapSlice)) return false;

    // Skip if data already equals lastGood (avoids firing errant signals)
    const lastGoodSlice = sliceAt(lastGood, nestedPath);
    if (deepEqual(localSlice, lastGoodSlice)) return false;

    const rolledBackTo = clone(lastGoodSlice);

    this._withPatchGuard(() => {
      if (nestedPath) {
        setNestedVal(data, nestedPath, rolledBackTo);
      } else {
        patchState(data, rolledBackTo, 'replace');
      }
    });

    this._clearDirtyMatching(status, data, lastGood, nestedPath);

    this._dispatchSyncEvent(entry, 'rz:store:sync:rollback', {
      storeName,
      operation: 'push',
      data,
      rolledBackTo,
      nestedPath,
      error,
      reason: 'push-error',
    });

    return true;
  }

  private _scheduleMutate(entry: StoreEntry) {
    if (!entry.listeners) return;

    const wasEmpty = this._pendingMutates.size === 0;
    this._pendingMutates.add(entry);

    if (wasEmpty) {
      queueMicrotask(() => {
        const toNotify = [...this._pendingMutates];
        this._pendingMutates.clear();
        for (const pending of toNotify) {
          const listeners = pending.listeners;
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
  onEdit(storeName: string, callback: () => void): VoidFn {
    const entry = this._stores.get(storeName);
    if (!entry) return () => {};

    let listeners = entry.listeners;
    if (!listeners) {
      listeners = new Set();
      entry.listeners = listeners;
      // Seed lazy tracker propagation across the initial tree
      if (entry.data) {
        seedPropagation(entry.data);
      }
    }
    listeners.add(callback);
    return () => {
      listeners.delete(callback);
      if (listeners.size === 0 && entry.listeners === listeners) {
        entry.listeners = undefined;
      }
    };
  }

  /**
   * Retrieves the source `<script rz-store>` element for a registered store.
   */
  elementFor(storeName: string): Element | undefined {
    return this._stores.get(storeName)?.el;
  }

  /**
   * Returns an iterable object containing every `<script rz-store>` element
   * registered in the store manager.
   */
  *elements(): Iterable<Element> {
    for (const entry of this._stores.values()) {
      if (entry.el) {
        yield entry.el;
      }
    }
  }

  /**
   * Registers a new store and returns its reactive proxy.
   */
  create<T extends object = any>(
    storeName: string,
    state: T,
    config?: Partial<SyncConfig>,
    el?: Element,
  ): T {
    if (this._stores.has(storeName)) {
      fail(`A store named '${storeName}' already exists.`);
    }

    const entry = this._register(storeName, state, config, el);
    this._updateLastGood(entry, state);

    return entry.data;
  }

  /**
   * Overwrites store state, clears dirty flags, resets the store's initial data
   * snapshot, and pulls the snapshot of the most recently server-confirmed state.
   */
  update<T extends object = any>(
    storeName: string,
    state: object,
    config?: Partial<SyncConfig>,
  ): T {
    const entry = this._stores.get(storeName);
    if (!entry) {
      fail(`Store '${storeName}' does not exist.`);
    }

    const action = config?.action || entry.config?.action || 'replace';

    this._withPatchGuard(() => patchState(entry.data, state, action));
    entry.initial = clone(state);
    entry.lastGood = clone(state);
    this._clearAllDirty(entry);

    if (config) {
      this._setConfig(entry, config);
    }

    return entry.data;
  }

  /**
   * Returns the reactive proxy for a store, or `undefined`.
   */
  get<T extends object = any>(storeName: string): T | undefined {
    return this._stores.get(storeName)?.data;
  }

  /**
   * Returns a deep-cloned non-reactive copy of the store's current data.
   */
  snapshot<T = any>(storeName: string): T | undefined {
    const data = this._stores.get(storeName)?.data;
    return data ? clone(data) : undefined;
  }

  /**
   * Returns `true` if a store with the provided name exists.
   */
  has(storeName: string): boolean {
    return this._stores.has(storeName);
  }

  /**
   * Returns the status object for a store, or `undefined`. Available store
   * status properties are `loading`, `error`, `lastSync`, and `dirty`.
   */
  status(storeName: string): StoreStatus | undefined {
    return this._stores.get(storeName)?.status;
  }

  /**
   * Patches `SyncConfig` for a store. Warns if the store is missing.
   */
  config(storeName: string, config: Partial<SyncConfig>) {
    const entry = this._stores.get(storeName);
    if (!entry) {
      __DEV__ && warn(`Cannot configure store '${storeName}': store not found.`);
      return;
    }
    this._setConfig(entry, config);
  }

  /**
   * Triggers a manual store push with optional request overrides.
   */
  async push(storeName: string, config?: StoreRequestOptions): Promise<void> {
    return this._request(storeName, 'push', config);
  }

  /**
   * Pulls fresh store data from the server, unless a push is currently in flight.
   */
  async pull(storeName: string, config?: StoreRequestOptions): Promise<void> {
    if (this.status(storeName)?.loading === 'push') return;
    return this._request(storeName, 'pull', config);
  }

  /**
   * Reverts a store to its initial state, clears dirty flags, and pulls
   * the snapshot of the most recently server-confirmed state.
   */
  reset(storeName: string) {
    const entry = this._stores.get(storeName);
    if (!entry) {
      __DEV__ && warn(`Cannot reset store '${storeName}': store not found.`);
      return;
    }

    const { data, initial } = entry;

    this._withPatchGuard(() => patchState(data, clone(initial), 'replace'));
    this._updateLastGood(entry, data);
    this._clearAllDirty(entry);
  }

  /**
   * Drops all per-store state from the manager. Existing references to the proxy
   * keep working but desync. Intended for tear-down of dynamically-created stores.
   */
  remove(storeName: string) {
    const entry = this._stores.get(storeName);
    if (entry) {
      this._pendingMutates.delete(entry);
    }
    this._stores.delete(storeName);
  }
}
