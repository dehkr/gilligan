import { dispatch } from '../dom/events';
import { type LifecycleHandle, runRequestLifecycle } from '../net/lifecycle';
import { request } from '../net/request';
import { reactive, seedPropagation, trackDirty } from '../reactivity/reactive';
import type {
  DirectiveSlug,
  LifecycleEventMap,
  RouseRequest,
  RouseResponse,
  StorePatchEvent,
  SyncRequest,
  VoidFn,
} from '../types';
import type { RouseApp } from './app';
import { getDirectiveValue } from './attributes';
import { type HttpMethod, STORE_PREFIX } from './constants';
import { fail, warn } from './diagnostics';
import { parseStoreRef } from './parser';
import { deleteNestedVal, getNestedVal, getPathRoot, setNestedVal } from './path';
import { clone, deepEqual, isOwnDataProp, isPlainObject, patchState } from './state';

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

/**
 * A store's standing sync policy. Seeded at init, applied to every push and pull.
 *
 * `indicator` is deliberately absent: it belongs to the trigger, not the store. A
 * store has many triggers, and `resolveIndicators` takes a single value, so a
 * policy-level indicator would silently override every trigger's `rz-indicator`.
 */
export interface SyncPolicy extends Omit<SyncRequest, 'url' | 'indicator'> {
  /** Endpoint for push and pull. */
  url: string;
  /** HTTP method for push. Defaults to `POST`. Pull is always `GET`. */
  pushMethod?: HttpMethod;
}

export interface StoreRequestOptions {
  url?: string;
  /** `triggerEl` is omitted: the top-level field is its only home. */
  overrides?: Omit<SyncRequest, 'triggerEl'>;
  nestedPath?: string;
  rollbackOnError?: boolean;
  triggerEl?: Element;
}

interface StoreEntry {
  name: string;
  data: any;
  status: StoreStatus;
  initial: any;
  config?: SyncPolicy;
  lastGood?: any;
  activeReq?: symbol;
  el?: Element;
  listeners?: Set<VoidFn>;
  touched?: Set<string>;
}

/**
 * Returns the nested slice at `path`, or the whole object when no path is given.
 */
function sliceAt(obj: any, path?: string) {
  return path ? getNestedVal(obj, path) : obj;
}

/**
 * Protocol headers describing the sync to the server. Merged under the user layers,
 * so `rz-headers="Rouse-Store: null"` can drop any of them.
 */
function syncHeaders(
  operation: 'push' | 'pull',
  storeName: string,
  nestedPath?: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    'Rouse-Sync': operation,
    'Rouse-Store': storeName,
  };

  if (nestedPath) {
    headers['Rouse-Path'] = nestedPath;
  }

  return headers;
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
 * The central manager for all reactive stores and their network logic.
 * Instantiated once per RouseApp to ensure isolation.
 */
export class StoreManager {
  private app: RouseApp;

  private _stores = new Map<string, StoreEntry>();
  private _pendingFlush = new Set<StoreEntry>();
  private _isPatching = false;

  constructor(app: RouseApp) {
    this.app = app;
  }

  private _setConfig(entry: StoreEntry, partial?: Partial<SyncPolicy>) {
    entry.config = { url: '', ...entry.config, ...partial };
  }

  private _register(
    storeName: string,
    state: object,
    programmaticConfig?: Partial<SyncPolicy>,
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

      entry.touched ??= new Set();
      entry.touched.add(rootKey);

      this._scheduleFlush(entry);
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

  /**
   * Recomputes dirty flags against `lastGood`. The only writer of `status.dirty`.
   * Without `roots`, walks every root in the data or the baseline, so a root
   * deleted locally still reads dirty.
   */
  private _reconcileDirty(entry: StoreEntry, roots?: Iterable<string>) {
    const { data, status } = entry;
    const baseline = entry.lastGood ?? {};
    const keys = roots ?? new Set([...Object.keys(data), ...Object.keys(baseline)]);

    for (const key of keys) {
      // Accessors and methods are absent from `lastGood` (clone strips them), so
      // comparing them would mark every getter permanently dirty. A key missing
      // from `data` entirely is a deleted root and must still be compared.
      if (!isOwnDataProp(data, key) && Object.getOwnPropertyDescriptor(data, key)) {
        continue;
      }

      if (deepEqual(data[key], baseline[key])) {
        delete status.dirty[key];
      } else {
        status.dirty[key] = true;
      }
    }
  }

  private _dispatchPatchEvent<E extends StorePatchEvent>(
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
    const policy: Partial<SyncPolicy> = config ?? {};
    const { url: policyUrl, pushMethod, headers: policyHeaders, ...transport } = policy;

    const url = manualConfig?.url || overrides.url || policyUrl;

    if (!url) {
      __DEV__ && warn(`Cannot ${operation} store '${storeName}': URL not configured.`);
      return;
    }

    // Pull is prescribed GET; only push has a configurable verb.
    const method = operation === 'push' ? pushMethod || 'POST' : 'GET';

    const nestedPath = manualConfig?.nestedPath;

    // Layers, later wins: protocol defaults, app config, store policy, programmatic
    // overrides. Headers merge per key so one layer never drops another's keys.
    const requestOptions: RouseRequest = {
      credentials: this.app.config.credentials,
      ...transport,
      ...overrides,
      headers: {
        ...syncHeaders(operation, storeName, nestedPath),
        ...this.app.config.headers,
        ...policyHeaders,
        ...overrides.headers,
      },
      method,
      triggerEl: manualConfig?.triggerEl,
      abortKey: overrides.abortKey ?? transport.abortKey ?? `${operation}_${storeName}`,
      rollbackOnError:
        manualConfig?.rollbackOnError ??
        overrides.rollbackOnError ??
        transport.rollbackOnError ??
        false,
    };

    // Body for push: full data, or a nested slice if nestedPath is provided
    if (operation === 'push') {
      requestOptions.body = sliceAt(data, nestedPath);
    }

    // Request-axis events prefer the trigger element, falling back to the store's
    // own element like the destination axis does. The fallback is deliberate: a
    // store has a home element, unlike a bare fetch, which fires from app.root.
    const firingEl =
      manualConfig?.triggerEl ?? this.elementFor(storeName) ?? this.app.root;

    await runRequestLifecycle({
      el: firingEl,
      root: this.app.root,
      prefix: operation === 'push' ? 'rz:push' : 'rz:pull',
      configDetail: { storeName, config: requestOptions, url, method },
      terminalDetail: (result) => ({ storeName, result }),
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

    const reqToken = Symbol(__DEV__ ? 'rz.request' : '');
    entry.activeReq = reqToken;

    const snapshot = clone(data);
    status.loading = operation;
    status.error = null;

    try {
      const result = await request(url, requestOptions, this.app);
      handle.settle(result);

      // A superseded request must not touch store data. Its snapshot is stale, so
      // both the reconcile and the rollback target belong to a request that no
      // longer owns the store. `finally` already leaves `loading` to the winner.
      if (entry.activeReq !== reqToken) return result;

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
    const { name: storeName, data, status } = entry;

    const nestedPath = manualConfig?.nestedPath;

    // Request-scoped, not response-scoped: a 200 means the data reached the server,
    // so this stands even when the echo below is never applied (mid-flight skip, or
    // a listener cancelling `:before`).
    if (operation === 'push') {
      status.lastSync = Date.now();
      this._clearDirtyMatching(status, data, snapshot, nestedPath);
    }

    const beforeEvent = this._dispatchPatchEvent(
      entry,
      'rz:store:patch:before',
      {
        storeName,
        operation,
        data,
        payload: result.data,
        nestedPath,
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
        this._dispatchPatchEvent(entry, 'rz:store:patch:skipped', {
          storeName,
          operation,
          localData: localSlice,
          serverData: sliceAt(payload, nestedPath),
          response: result,
          nestedPath,
        });
        return;
      }

      this._patchPayload(data, payload, nestedPath);
    }

    if (operation === 'pull') {
      status.lastSync = Date.now();
    }

    this._updateLastGood(entry, data);

    this._dispatchPatchEvent(entry, 'rz:store:patch', {
      storeName,
      operation,
      data,
      response: result,
      payload,
      nestedPath,
    });
  }

  /**
   * Applies the payload to the store as a JSON Merge Patch, whole or at
   * `nestedPath`. A path absent from the payload writes nothing; a `null` at the
   * path removes the slice.
   */
  private _patchPayload(data: any, payload: any, nestedPath?: string) {
    if (!nestedPath) {
      this._withPatchGuard(() => patchState(data, payload, 'merge'));
      return;
    }

    const incoming = getNestedVal(payload, nestedPath);
    if (incoming === undefined) return;

    if (incoming === null) {
      this._withPatchGuard(() => deleteNestedVal(data, nestedPath));
      return;
    }

    this._withPatchGuard(() => {
      if (!isPlainObject(incoming)) {
        setNestedVal(data, nestedPath, incoming);
        return;
      }

      let target = getNestedVal<Record<string, any>>(data, nestedPath);

      // Seed an object when the slice is missing or holds a non-object, so the
      // merge drops nulls nested inside the incoming patch (RFC 7396).
      if (!isPlainObject(target)) {
        setNestedVal(data, nestedPath, {});
        target = getNestedVal<Record<string, any>>(data, nestedPath);
      }

      // `setNestedVal` bails when an intermediate is a primitive, so the seed
      // may not have landed.
      if (target) {
        patchState(target, incoming, 'merge');
      }
    });
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

  /**
   * Patches the store's data, then makes it the new baseline: both restore targets
   * (`reset()` and rollback) and the dirty flags are refreshed to match.
   */
  private _adoptState(entry: StoreEntry, state: object, action: 'replace' | 'merge') {
    this._withPatchGuard(() => patchState(entry.data, state, action));
    entry.initial = clone(entry.data);
    this._updateLastGood(entry, entry.data);
    this._clearAllDirty(entry);
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

    this._dispatchPatchEvent(entry, 'rz:store:patch:rollback', {
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

  /**
   * Queues a store for end-of-microtask reconciliation, coalescing a batch of
   * synchronous writes into one dirty recompute and one round of notifications.
   */
  private _scheduleFlush(entry: StoreEntry) {
    const wasEmpty = this._pendingFlush.size === 0;
    this._pendingFlush.add(entry);
    if (!wasEmpty) return;

    queueMicrotask(() => {
      const flushing = [...this._pendingFlush];
      this._pendingFlush.clear();

      for (const pending of flushing) {
        const { touched } = pending;
        if (touched) {
          pending.touched = undefined;
          this._reconcileDirty(pending, touched);
        }
        // Reconciling first is what lets the `edit` trigger's dirty guard read a
        // current value from inside its own notification.
        pending.listeners?.forEach((callback) => callback());
      }
    });
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
    config?: Partial<SyncPolicy>,
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
   * Replaces the store's data, then clears dirty flags and refreshes both
   * snapshots: the one `reset()` restores to, and the last-good state a failed push
   * rolls back to. To change the store's sync configuration, use `config()`.
   */
  update<T extends object = any>(storeName: string, state: object): T {
    const entry = this._stores.get(storeName);
    if (!entry) {
      fail(`Store '${storeName}' does not exist.`);
    }

    this._adoptState(entry, state, 'replace');

    return entry.data;
  }

  /**
   * Writes a payload into a store as a JSON Merge Patch, the way a fetch response
   * routed by `rz-target="@store"` does. Fires the same events a push or pull
   * fires, so a listener sees one shape whatever produced the payload.
   *
   * @returns `false` if the store does not exist or a listener canceled the patch.
   */
  deposit(
    storeName: string,
    payload: object,
    options?: { response?: RouseResponse },
  ): boolean {
    const entry = this._getStore(storeName);
    if (!entry) return false;

    const { data } = entry;
    const response = options?.response;

    const beforeEvent = this._dispatchPatchEvent(
      entry,
      'rz:store:patch:before',
      { storeName, operation: 'fetch', data, payload },
      { cancelable: true },
    );
    if (beforeEvent.defaultPrevented) return false;

    const applied = beforeEvent.detail.payload as object;

    this._adoptState(entry, applied, 'merge');
    entry.status.lastSync = Date.now();

    this._dispatchPatchEvent(entry, 'rz:store:patch', {
      storeName,
      operation: 'fetch',
      data,
      payload: applied,
      response,
    });

    return true;
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
   * Patches `SyncPolicy` for a store. Warns if the store is missing.
   */
  config(storeName: string, config: Partial<SyncPolicy>) {
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
      this._pendingFlush.delete(entry);
    }
    this._stores.delete(storeName);
  }
}
