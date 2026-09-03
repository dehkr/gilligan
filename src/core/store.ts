import { type LifecycleHandle, runRequestLifecycle } from '../net/lifecycle';
import { request } from '../net/request';
import { reactive, seedPropagation, trackDirty } from '../reactivity/reactive';
import type {
  DirectiveSlug,
  FetchRequest,
  LifecycleEventMap,
  RouseResponse,
  StorePatchEvent,
  SyncRequest,
  VoidFn,
} from '../types';
import type { RouseApp } from './app';
import { getDirectiveValue } from './attributes';
import { STORE_PREFIX } from './constants';
import { fail, warn } from './diagnostics';
import { dispatch } from './dispatch';
import { parseStoreRef } from './parser';
import { deleteNestedVal, getNestedVal, getPathRoot, setNestedVal } from './path';
import {
  clone,
  deepEqual,
  isOwnDataProp,
  isPlainObject,
  nullPaths,
  patchState,
} from './state';

/** Receives the store roots that changed in one batch of user edits. */
export type EditListener = (roots: ReadonlySet<string>) => void;

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
}

export interface StoreRequestOptions {
  url?: string;
  /** `triggerEl` is omitted: the top-level field is its only home. */
  overrides?: Omit<SyncRequest, 'triggerEl'>;
  nestedPath?: string;
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
  listeners?: Set<EditListener>;
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
 * so `data-rz-headers="Rouse-Store: null"` can drop any of them.
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

  // A push body is a JSON Merge Patch (RFC 7396). A pull carries no body.
  if (operation === 'push') {
    headers['Content-Type'] = 'application/merge-patch+json';
  }

  if (nestedPath) {
    headers['Rouse-Path'] = nestedPath;
  }

  return headers;
}

/**
 * Warns for each object property holding `null` in a baseline the caller is
 * asserting. Dev-only; gate every call with `__DEV__`.
 */
function warnNullFields(storeName: string, state: object) {
  nullPaths(state).forEach((path) =>
    warn(
      `Store '${storeName}': '${path}' is null. Sync reads null as a delete (RFC 7396), so it cannot rest as a value. Use '' or omit the key.`,
    ),
  );
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
    if (!target) {
      return null;
    }

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
        `rz-${slug}: missing store reference. To self-reference a store on a <script> element, add data-rz-store as well.`,
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
    __DEV__ && warnNullFields(storeName, state);

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

    if (el) {
      entry.el = el;
    }

    return entry;
  }

  private _getStore(storeName: string) {
    const entry = this._stores.get(storeName);
    __DEV__ && !entry && warn(`Store '${storeName}' not found.`);
    return entry;
  }

  /**
   * Advances the `lastGood` baseline to `source`, whole or at a single root,
   * and reconciles the dirty flags that move with it.
   */
  private _updateLastGood(entry: StoreEntry, source: any, rootKey?: string) {
    if (!rootKey) {
      entry.lastGood = clone(source);
      this._reconcileDirty(entry);
      return;
    }

    entry.lastGood ??= {};

    if (Object.hasOwn(source, rootKey)) {
      entry.lastGood[rootKey] = clone(source[rootKey]);
    } else {
      delete entry.lastGood[rootKey];
    }

    this._reconcileDirty(entry, [rootKey]);
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
    const { url: policyUrl, headers: policyHeaders, ...transport } = policy;

    const url = manualConfig?.url || overrides.url || policyUrl;

    if (!url) {
      __DEV__ && warn(`Cannot ${operation} store '${storeName}': URL not configured.`);
      return;
    }

    // Both verbs are prescribed: a push is a merge patch, a pull carries no body.
    const method = operation === 'push' ? 'PATCH' : 'GET';

    const nestedPath = manualConfig?.nestedPath;

    // Layers, later wins: protocol defaults, app config, store policy, programmatic
    // overrides. Headers merge per key so one layer never drops another's keys.
    const requestOptions: FetchRequest = {
      credentials: this.app.config.credentials,
      timeout: this.app.config.timeout,
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
   * Sends the request and applies the outcome to the store: rolls back a failed push,
   * otherwise reconciles the response. Tracks the request so a superseded one leaves
   * `loading` alone when it settles.
   */
  private async _sendAndApply(
    entry: StoreEntry,
    operation: 'push' | 'pull',
    url: string,
    requestOptions: FetchRequest,
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
      if (entry.activeReq !== reqToken) {
        return result;
      }

      if (result.error) {
        if (result.error.status === 'CANCELED') {
          return result;
        }

        status.error = result.error.message;

        if (operation === 'push') {
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
      this._updateLastGood(entry, snapshot, getPathRoot(nestedPath));
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

      // Local state moved mid-flight; keep the edit and skip the echo
      if (!deepEqual(localSlice, sliceAt(snapshot, nestedPath))) {
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

      this._patchPayload(entry, payload, nestedPath);
    }

    if (operation === 'pull') {
      status.lastSync = Date.now();
    }

    this._updateLastGood(entry, data, getPathRoot(nestedPath));

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
  private _patchPayload(entry: StoreEntry, payload: any, nestedPath?: string) {
    const { data } = entry;

    if (!nestedPath) {
      this._withPatchGuard(entry, () => patchState(data, payload, 'merge'));
      return;
    }

    const incoming = getNestedVal(payload, nestedPath);
    if (incoming === undefined) return;

    if (incoming === null) {
      this._withPatchGuard(entry, () => deleteNestedVal(data, nestedPath));
      return;
    }

    this._withPatchGuard(entry, () => {
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

  /**
   * Runs a framework write with dirty tracking suppressed, then reconciles the
   * dirty flags against the baseline. Every framework mutation of store data
   * goes through here, so the reconcile cannot be forgotten.
   */
  private _withPatchGuard(entry: StoreEntry, fn: VoidFn) {
    this._isPatching = true;
    try {
      fn();
    } finally {
      this._isPatching = false;
      this._reconcileDirty(entry);
    }
  }

  /**
   * Patches the store's data, then makes it the new baseline: both restore targets
   * (`reset()` and rollback) and the dirty flags are refreshed to match.
   */
  private _adoptState(entry: StoreEntry, state: object, action: 'replace' | 'merge') {
    this._withPatchGuard(entry, () => patchState(entry.data, state, action));
    entry.initial = clone(entry.data);
    this._updateLastGood(entry, entry.data);
  }

  /** Writes `value` into the store's data, whole or at `path`, as a framework write. */
  private _writeSlice(entry: StoreEntry, path: string | undefined, value: any) {
    this._withPatchGuard(entry, () => {
      if (path) {
        setNestedVal(entry.data, path, value);
      } else {
        patchState(entry.data, value, 'replace');
      }
    });
  }

  private _maybeRollback(
    entry: StoreEntry,
    snapshot: any,
    nestedPath: string | undefined,
    error: unknown,
  ): void {
    const { name: storeName, data, lastGood } = entry;

    // Skip when the user has kept editing during flight
    const localSlice = sliceAt(data, nestedPath);
    if (!deepEqual(localSlice, sliceAt(snapshot, nestedPath))) return;

    // Skip if data already equals lastGood (avoids firing errant signals)
    const lastGoodSlice = sliceAt(lastGood, nestedPath);
    if (deepEqual(localSlice, lastGoodSlice)) return;

    const rolledBackTo = clone(lastGoodSlice);
    this._writeSlice(entry, nestedPath, rolledBackTo);

    this._dispatchPatchEvent(entry, 'rz:store:patch:rollback', {
      storeName,
      operation: 'push',
      data,
      rolledBackTo,
      nestedPath,
      error,
    });
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
        const touched = pending.touched ?? new Set<string>();
        pending.touched = undefined;

        this._reconcileDirty(pending, touched);

        // Reconciling first is what lets the `edit` trigger's dirty guard read a
        // current value from inside its own notification.
        pending.listeners?.forEach((callback) => callback(touched));
      }
    });
  }

  /**
   * Listens for user-driven mutations to the store. Returns a cleanup function.
   *
   * The store must already exist. Stores declared in markup using `<script data-rz-store>`
   * are registered during `start()`, so subscribe after that call rather than before it.
   */
  onEdit(storeName: string, callback: EditListener): VoidFn {
    const entry = this._getStore(storeName);
    if (!entry) {
      return () => {};
    }

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
   * Retrieves the source `<script data-rz-store>` element for a registered store.
   */
  elementFor(storeName: string): Element | undefined {
    return this._stores.get(storeName)?.el;
  }

  /**
   * Returns an iterable object containing every `<script data-rz-store>` element
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

    __DEV__ && warnNullFields(storeName, state);

    this._adoptState(entry, state, 'replace');

    return entry.data;
  }

  /**
   * Writes a payload into a store as a JSON Merge Patch, the way a fetch response
   * or a stream message routed by `data-rz-target="@store"` does. Fires the same
   * events a push or pull fires, so a listener sees one shape whatever produced
   * the payload.
   *
   * @returns `false` if the store does not exist or a listener canceled the patch.
   */
  deposit(
    storeName: string,
    payload: object,
    options?: { response?: RouseResponse; operation?: 'fetch' | 'sse' },
  ): boolean {
    const entry = this._getStore(storeName);
    if (!entry) {
      return false;
    }

    const { data } = entry;
    const response = options?.response;
    const operation = options?.operation ?? 'fetch';

    const beforeEvent = this._dispatchPatchEvent(
      entry,
      'rz:store:patch:before',
      { storeName, operation, data, payload },
      { cancelable: true },
    );

    if (beforeEvent.defaultPrevented) {
      return false;
    }

    const applied = beforeEvent.detail.payload as object;

    this._adoptState(entry, applied, 'merge');
    entry.status.lastSync = Date.now();

    this._dispatchPatchEvent(entry, 'rz:store:patch', {
      storeName,
      operation,
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
   * Returns a copy of the last synced state: what a push or pull last confirmed,
   * or what `commit()`, `update()`, or `deposit()` last asserted. This is the
   * reference point for unsaved changes and the target a failed push rolls back
   * to. Non-reactive, like `snapshot()`.
   */
  baseline<T = any>(storeName: string): T | undefined {
    const lastGood = this._stores.get(storeName)?.lastGood;
    return lastGood ? clone(lastGood) : undefined;
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
   * Returns `true` when the store has unsaved changes. Pass a dot path to ask
   * about a single field or branch instead of the whole store.
   *
   * Without a path the answer comes from the store's status, which updates a
   * microtask after an edit. With a path the comparison runs on the spot.
   */
  isDirty(storeName: string, path?: string): boolean {
    const entry = this._getStore(storeName);
    if (!entry) {
      return false;
    }

    if (!path) {
      return Object.keys(entry.status.dirty).length > 0;
    }

    return !deepEqual(getNestedVal(entry.data, path), getNestedVal(entry.lastGood, path));
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
   * Restores the store to its initial state, and makes that the new baseline,
   * so nothing reads as dirty afterward.
   *
   * To restore the last state the server confirmed instead, use `revert()`.
   */
  reset(storeName: string) {
    const entry = this._stores.get(storeName);
    if (!entry) {
      __DEV__ && warn(`Cannot reset store '${storeName}': store not found.`);
      return;
    }

    const { data, initial } = entry;

    this._withPatchGuard(entry, () => patchState(data, clone(initial), 'replace'));
    this._updateLastGood(entry, data);
  }

  /**
   * Discards unsaved changes, restoring the store to the last synced state, which
   * `baseline()` returns. Pass a dot path to revert a single field or branch
   * instead of the whole store. Returns `true` if anything changed.
   *
   * To restore the state the store started with, use `reset()`.
   */
  revert(storeName: string, path?: string): boolean {
    const entry = this._stores.get(storeName);
    if (!entry) {
      __DEV__ && warn(`Cannot revert store '${storeName}': store not found.`);
      return false;
    }

    const lastGoodSlice = sliceAt(entry.lastGood, path);
    if (deepEqual(sliceAt(entry.data, path), lastGoodSlice)) {
      return false;
    }

    this._writeSlice(entry, path, clone(lastGoodSlice));
    return true;
  }

  /**
   * Marks the store's current data as the new baseline, so nothing reads as dirty.
   * Does not send anything to the server. Use it when state reached the server by
   * some means Rouse did not perform, such as a native form submit or a socket
   * acknowledgement.
   */
  commit(storeName: string) {
    const entry = this._stores.get(storeName);
    if (!entry) {
      __DEV__ && warn(`Cannot commit store '${storeName}': store not found.`);
      return;
    }

    this._updateLastGood(entry, entry.data);
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
