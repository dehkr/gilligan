import type { RouseApp } from './core/app';
import type {
  ITEM_KEY,
  ITEM_META_KEY,
  ListenTarget,
  RENDER_PARENT,
  SwapMethod,
} from './core/constants';
import type { StoreManager } from './core/store';

/** Brand for {@link BoundCleanupFn}, keeping arbitrary `VoidFn`s out of directive-teardown positions. */
declare const CLEANUP: unique symbol;

/** Every `rz-*` attribute name supported by the framework, without the prefix. */
export type DirectiveSlug =
  | 'attr'
  | 'class'
  | 'fetch'
  | 'fetch-config'
  | 'headers'
  | 'html'
  | 'indicator'
  | 'key'
  | 'model'
  | 'on'
  | 'prop'
  | 'pull'
  | 'push'
  | 'render'
  | 'scope'
  | 'store'
  | 'store-config'
  | 'style'
  | 'target'
  | 'text'
  | 'wake';

/** Detail for `rz:app:start`, `rz:app:ready`, and `rz:app:destroy`. */
export interface AppEventDetail {
  /** The app instance the event fired from. */
  app: RouseApp;
}

/** Detail for `rz:scope:init`. */
export interface ScopeInitDetail {
  /** The context passed into the scope's setup function. */
  context: ScopeCtx;
  /** The scope object the setup function returned. */
  instance: Scope;
}

/** Detail for `rz:scope:connect` and `rz:scope:disconnect`. */
export interface ScopeLifecycleDetail {
  /** The scope whose bindings were attached (connect) or detached (disconnect). */
  instance: Scope;
}

/** Detail for `rz:fetch:config`. */
export interface FetchConfigDetail {
  /**
   * The final unified request config. Mutable in place by listeners; replacing the object
   * has no effect on the request. Carries `method` but not the resolved `url`.
   */
  config: FetchRequest;
  /** The resolved request URL actually fetched. Surfaced here because `config` does not carry it. */
  url: string;
  /** The resolved HTTP method. Also present on `config`; duplicated here for convenience. */
  method: string;
}

/**
 * Detail for `rz:fetch:start`, `rz:fetch:abort`, and `rz:fetch:end`. The config
 * detail minus the request-identifying fields, which only `:config` carries.
 */
export type FetchLifecycleDetail = Omit<FetchConfigDetail, 'url' | 'method'>;

/** Detail for `rz:fetch:success`: the full response object. */
export type FetchSuccessDetail = RouseResponse;

/** Detail for `rz:fetch:success:json`: response with a parsed-JSON body (object/array). */
export type FetchSuccessJsonDetail = RouseResponse<Record<string, any> | any[]>;

/** Detail for `rz:fetch:success:html`: response with an HTML/text body. */
export type FetchSuccessHtmlDetail = RouseResponse<string>;

/** Detail for `rz:fetch:success:file`: response with a binary body (Blob/ArrayBuffer). */
export type FetchSuccessFileDetail = RouseResponse<Blob | ArrayBuffer>;

/** Detail for `rz:fetch:error`: the full response object. */
export type FetchErrorDetail = RouseResponse;

/** Detail for `rz:fetch:error:json`: error response with a parsed-JSON body (object/array). */
export type FetchErrorJsonDetail = RouseResponse<Record<string, any> | any[]>;

/** Detail for `rz:fetch:error:html`: error response with an HTML/text body. */
export type FetchErrorHtmlDetail = RouseResponse<string>;

/** Detail for `rz:fetch:error:file`: error response with a binary body (Blob/ArrayBuffer). */
export type FetchErrorFileDetail = RouseResponse<Blob | ArrayBuffer>;

/** Detail for `rz:push:config` and `rz:pull:config`; cancelable. Listeners can mutate `config`. */
export interface PushPullConfigDetail {
  /** Name of the store being synced. */
  storeName: string;
  /**
   * The final unified request config. Mutable in place by listeners; replacing the object
   * has no effect on the request. Carries `method` but not the resolved `url`.
   */
  config: FetchRequest;
  /** The resolved request URL. */
  url: string;
  /** The resolved HTTP method. */
  method: string;
}

/**
 * Detail for `rz:push`/`rz:pull` `:start`, `:abort`, and `:end`. The config detail
 * minus the request-identifying fields, which only `:config` carries.
 */
export type PushPullLifecycleDetail = Omit<PushPullConfigDetail, 'url' | 'method'>;

/** Detail for `rz:push`/`rz:pull` `:success` and `:error`: the full response, plus the store name. */
export interface PushPullResultDetail {
  /** Name of the store being synced. */
  storeName: string;
  /** The full response object that settled the request. */
  result: RouseResponse;
}

/** Shared fields present on every `rz:store:patch:*` event detail. */
export interface BaseStorePatch {
  /** Name of the store being patched. */
  storeName: string;
  /** Network operation that produced the payload. */
  operation: 'push' | 'pull' | 'fetch';
  /** Dot-path of the targeted slice, when only part of the store was patched. */
  nestedPath?: string;
}

/** Detail for `rz:store:patch`. */
export interface StorePatchDetail extends BaseStorePatch {
  /** The store's local data after the successful patch. */
  data: any;
  /** The response that drove the patch. */
  response?: RouseResponse;
  /** The server payload applied to the store, when provided. */
  payload?: any;
}

/** Detail for `rz:store:patch:before`. */
export interface StorePatchBeforeDetail extends BaseStorePatch {
  /** The store's current local data, about to be patched. */
  data: any;
  /** The server payload about to be applied, when provided. */
  payload?: any;
}

/** Detail for `rz:store:patch:skipped`. */
export interface StorePatchSkippedDetail extends BaseStorePatch {
  /** The local slice with unsaved edits that was kept. */
  localData: any;
  /** The incoming server slice that was not applied. */
  serverData: any;
  /** The response carrying the server data. */
  response: RouseResponse;
}

/** Detail for `rz:store:patch:rollback`. */
export interface StorePatchRollbackDetail extends BaseStorePatch {
  /** The store's local data after the rollback (now equal to the last-good snapshot). */
  data: any;
  /** The last-good snapshot the state was reverted to. */
  rolledBackTo: any;
  /** The push error that triggered the rollback. */
  error: unknown;
}

/** Detail for `rz:dom:swap:before` and `rz:dom:swap`. */
export interface DomSwapDetail {
  /** The element being mutated. */
  target: Element;
  /** The swap method used to apply the payload. */
  method: SwapMethod;
  /** The HTML string to insert. Mutable by `rz:dom:swap:before` listeners. */
  payload: string;
  /** Whether the swap originated from a fetch response or a programmatic `swap()` call. */
  source: 'fetch' | 'programmatic';
}

/** Maps every lifecycle event name to the shape of `event.detail`. */
export interface LifecycleEventMap {
  /** Fires when the app starts, before the initial directive scan. */
  'rz:app:start': AppEventDetail;
  /** Fires after the initial scan completes and the app is ready. */
  'rz:app:ready': AppEventDetail;
  /** Fires when the app instance is destroyed. */
  'rz:app:destroy': AppEventDetail;
  /** Fires after the setup function runs, before bindings attach. */
  'rz:scope:init': ScopeInitDetail;
  /** Fires when scope bindings are attached. */
  'rz:scope:connect': ScopeLifecycleDetail;
  /** Fires when scope bindings are detached. */
  'rz:scope:disconnect': ScopeLifecycleDetail;
  /** Fires when the scope is torn down. */
  'rz:scope:destroy': undefined;
  /** Fires before the request is sent; cancelable. Listeners can mutate `config`. */
  'rz:fetch:config': FetchConfigDetail;
  /** Fires when the fetch starts, after config. */
  'rz:fetch:start': FetchLifecycleDetail;
  /** Fires if the fetch is aborted. */
  'rz:fetch:abort': FetchLifecycleDetail;
  /** Fires when the request settles, after success or error. */
  'rz:fetch:end': FetchLifecycleDetail;
  /** Fires when the request completes with an OK status. */
  'rz:fetch:success': FetchSuccessDetail;
  /** Fires after `rz:fetch:success` when the body is parsed JSON (object/array). */
  'rz:fetch:success:json': FetchSuccessJsonDetail;
  /** Fires after `rz:fetch:success` when the body is HTML/text. */
  'rz:fetch:success:html': FetchSuccessHtmlDetail;
  /** Fires after `rz:fetch:success` when the body is a Blob/ArrayBuffer. */
  'rz:fetch:success:file': FetchSuccessFileDetail;
  /** Fires when the request fails (non-OK status, network error, or cancellation). */
  'rz:fetch:error': FetchErrorDetail;
  /** Fires after `rz:fetch:error` when the body is parsed JSON (object/array). */
  'rz:fetch:error:json': FetchErrorJsonDetail;
  /** Fires after `rz:fetch:error` when the body is HTML/text. */
  'rz:fetch:error:html': FetchErrorHtmlDetail;
  /** Fires after `rz:fetch:error` when the body is a Blob/ArrayBuffer. */
  'rz:fetch:error:file': FetchErrorFileDetail;
  /** Fires before a push is sent; cancelable. Listeners can mutate `config`. */
  'rz:push:config': PushPullConfigDetail;
  /** Fires when the push starts, after config. */
  'rz:push:start': PushPullLifecycleDetail;
  /** Fires if the push is aborted (overlapping programmatic pushes sharing an abortKey). */
  'rz:push:abort': PushPullLifecycleDetail;
  /** Fires when the push completes with an OK status. */
  'rz:push:success': PushPullResultDetail;
  /** Fires when the push fails (non-OK status or network error). */
  'rz:push:error': PushPullResultDetail;
  /** Fires when the push settles, after success/error/abort. */
  'rz:push:end': PushPullLifecycleDetail;
  /** Fires before a pull is sent; cancelable. Listeners can mutate `config`. */
  'rz:pull:config': PushPullConfigDetail;
  /** Fires when the pull starts, after config. */
  'rz:pull:start': PushPullLifecycleDetail;
  /** Fires if the pull is aborted (overlapping programmatic pulls sharing an abortKey). */
  'rz:pull:abort': PushPullLifecycleDetail;
  /** Fires when the pull completes with an OK status. */
  'rz:pull:success': PushPullResultDetail;
  /** Fires when the pull fails (non-OK status or network error). */
  'rz:pull:error': PushPullResultDetail;
  /** Fires when the pull settles, after success/error/abort. */
  'rz:pull:end': PushPullLifecycleDetail;
  /** Fires before a payload is applied to the local store; cancelable, and `payload` is mutable. Check `detail.operation` for what produced it. */
  'rz:store:patch:before': StorePatchBeforeDetail;
  /** Fires after a payload has been applied to the local store. Check `detail.operation` for what produced it. */
  'rz:store:patch': StorePatchDetail;
  /** Fires when the response carries server data but the store was edited while the request was in flight, so the server data is not applied and the local edit is kept. Push and pull only. */
  'rz:store:patch:skipped': StorePatchSkippedDetail;
  /** Fires after `rz:push:error` when local state is reverted to the last-good snapshot. */
  'rz:store:patch:rollback': StorePatchRollbackDetail;
  /** Fires before the swap executes; cancelable. Listeners can mutate `payload`. */
  'rz:dom:swap:before': DomSwapDetail;
  /** Fires after the swap has been applied to the DOM. */
  'rz:dom:swap': DomSwapDetail;
}

/** Union of every lifecycle event name the framework can dispatch. */
export type LifecycleEvent = keyof LifecycleEventMap;

/** The `rz:store:patch*` subset, fired from a store's element. */
export type StorePatchEvent = Extract<LifecycleEvent, `rz:store:patch${string}`>;

/** Any value that a reactive directive can bind to. Objects are used for conditional class/style maps; primitives for direct output. */
export type BindableValue =
  | string
  | string[]
  | number
  | boolean
  | null
  | undefined
  | Record<string, boolean>
  | Record<string, string>;

/** Any callable. Used where a function's signature is intentionally unconstrained. */
export type AnyFn = (...args: any[]) => any;

/** A no-argument, no-return function. */
export type VoidFn = () => void;

/** An event handler that optionally receives the triggering `Event`. */
export type ActionFn = (e?: Event) => void;

/** A teardown function returned by a bound directive. Branded to prevent accidental misuse. */
export type BoundCleanupFn = VoidFn & { [CLEANUP]: true };

/** The object returned by a setup function. Includes standard lifecycle hooks and custom state/methods. */
export type Scope = Record<string, any> & {
  /** Lifecycle hook, run when the scope connects (bindings attached). */
  connect?: () => void;
  /** Lifecycle hook, run when the scope disconnects (bindings detached). */
  disconnect?: () => void;
};

/** Per-instance render metadata. Internal to the engine and surfaced to handlers via `HandlerCtx.render`. Not resolvable from templates. */
export interface RenderMeta {
  /** The current loop item. Absent for item-less (boolean/number) render modes. */
  item: unknown;
  /** Zero-based position of this instance within the render. */
  index: number;
}

/**
 * The per-instance binding context an `rz-render` template instance is bound with.
 *
 * Structurally it's a `Scope` (so it threads through `bindDirectives` and the resolution chain unchanged) plus three
 * reserved symbol slots: the current item, its render metadata, and the parent state it layers over. Not a real
 * `rz-scope`: no lifecycle, no `ScopeCtx`.
 */
export type RenderContext = Scope & {
  /** The current render item. */
  [ITEM_KEY]?: unknown;
  /** Per-instance render metadata. */
  [ITEM_META_KEY]?: RenderMeta;
  /** The parent state this context layers over. */
  [RENDER_PARENT]?: Scope;
};

/**
 * The canonical, resolved representation of a trigger's modifiers.
 *
 * The HTML grammar (`click|debounce-300ms.once`) is its serialized form, produced by
 * `parseTriggers`. Consumers read fields from this object rather than scanning tokens.
 */
export interface TriggerOptions {
  /** Remove the listener after it fires. Events rejected by a filter don't count. */
  once?: boolean;
  /** Listen during the capture phase. */
  capture?: boolean;
  /** Attach as a passive listener. */
  passive?: boolean;

  /** Attach the listener elsewhere. Filters and trigger sources still act on the element. */
  listenOn?: ListenTarget;
  /** Fire only for events originating outside the element. Listens on `document`. */
  outside?: boolean;

  /** Fire only when the element is the event target, not a descendant. */
  self?: boolean;
  /** Allow unrequested system modifiers to be held. */
  loose?: boolean;
  /** `KeyboardEvent.key` value(s) to match, compared case-insensitively. */
  key?: string | string[];
  /** Require the Control key. */
  ctrl?: boolean;
  /** Require the Alt key. */
  alt?: boolean;
  /** Require the Shift key. */
  shift?: boolean;
  /** Require the Meta key. */
  meta?: boolean;

  /** Call `preventDefault()` before the action runs. */
  prevent?: boolean;
  /** Call `stopPropagation()` before the action runs. */
  stop?: boolean;
  /** Call `stopImmediatePropagation()` before the action runs. */
  stopImmediate?: boolean;

  /** Debounce the action. `true` uses the default wait. */
  debounce?: number | string | true;
  /** Throttle the action. `true` uses the default wait. */
  throttle?: number | string | true;
  /** Run on the leading edge of the timing window. */
  leading?: boolean;
  /** Run on the trailing edge of the timing window. */
  trailing?: boolean;

  /** Delay or period for the `timeout` and `interval` trigger sources. */
  wait?: number | string;
  /** Media query for the `media` trigger source. */
  query?: string;
}

/** Parsed trigger event with its resolved options. */
export type TriggerDef = {
  /** The DOM event or trigger-source name, stripped of modifiers. */
  event: string;
  /** The trigger's resolved modifiers. */
  options: TriggerOptions;
};

/** A trigger paired with its subject. `subject` is `null` when the directive resolves the URL/target from the element itself. */
export type TriggerSubjectPair = {
  /** The parsed trigger event and its modifiers. */
  trigger: TriggerDef;
  /** The URL/target the trigger acts on, or `null` when resolved from the element. */
  subject: string | null;
};

/**
 * The event type a name yields: a lifecycle event's typed detail, a native event's
 * own type, or `CustomEvent<any>` for names the DOM doesn't define.
 */
export type TriggerEvent<S extends string> = S extends keyof LifecycleEventMap
  ? CustomEvent<LifecycleEventMap[S]>
  : S extends keyof HTMLElementEventMap
    ? HTMLElementEventMap[S]
    : S extends keyof WindowEventMap
      ? WindowEventMap[S]
      : CustomEvent<any>;

/** A listener callback, or an object with `handleEvent`, as `addEventListener` accepts. */
export type EventCallback<E> = ((ev: E) => void) | { handleEvent(ev: E): void };

/** A stateless directive used to parse DOM attributes into a typed configuration object. */
export interface ConfigDirective<T> {
  /** Parse the element's attributes into the typed config `T`. Pure. No lifecycle, read on demand. */
  getConfig: (el: Element, ...args: any[]) => T;
}

/** Represents a persistent data or event binding between the DOM and application state. */
export interface BoundDirective {
  /** The `rz-*` attribute name (prefix omitted) this directive handles. */
  slug: DirectiveSlug;
  /** CSS selector string for elements with this directive. */
  selector: string;
  /**
   * Attach the binding for one pre-split `[key: value]` segment: `key` is the
   * trigger/token, `value` the subject. `scope` is the owning `Scope`, or `EMPTY_SCOPE`
   * when globally mounted. Returns a cleanup, or `undefined` if nothing was bound.
   */
  bind: (
    el: Element,
    scope: Scope,
    app: RouseApp,
    key: string,
    value: string,
  ) => BoundCleanupFn | undefined;
}

/** A directive that manages its own explicit initialization and teardown lifecycle. */
export interface StandaloneDirective<T extends Element = Element> {
  /** CSS selector string for elements with this directive. */
  selector: string;
  /** Set up the directive on `el`. Called by the initial scan and the mutation observer's add branch. */
  initialize: (el: T, app: RouseApp) => void;
  /** Tear down the directive when `el` leaves the DOM. */
  teardown: (el: T) => void;
}

/**
 * Custom error statuses for non-HTTP failures.
 *
 * - `CANCELED`: User or AbortController canceled the request.
 * - `TIMEOUT`: Request exceeded timeout threshold.
 * - `NETWORK_ERROR`: Fetch failed (offline, DNS, CORS, etc.).
 * - `PARSE_ERROR`: Response body couldn't be parsed.
 * - `INTERNAL_ERROR`: Unexpected error in request engine.
 * - `REDIRECTED`: Cross-origin redirect refused by the fetch engine.
 */
export type CustomErrorStatus =
  | 'CANCELED'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'PARSE_ERROR'
  | 'INTERNAL_ERROR'
  | 'REDIRECTED';

/** HTTP status codes (2xx-5xx) or custom error status. */
export type ErrorStatus = CustomErrorStatus | number;

/** Normalized error object. Can include a parsed response body for non-OK HTTP responses (JSON object/array or text/HTML string). */
export interface RequestError {
  /** Human-readable description of the failure. */
  message: string;
  /** HTTP status code, or a custom status for non-HTTP failures. */
  status: ErrorStatus;
  /** The underlying thrown value (native `Error`, `DOMException`, etc.) for non-HTTP failures. */
  original?: any;
  /** Parsed error-response body, for inspection. Aliases `result.data`. Mutating it affects what gets routed/rendered. */
  body?: unknown;
  /** Present with a PARSE_ERROR status; describes why the response body couldn't be parsed. */
  parseError?: string;
}

/** Request options shared by `rz-fetch` and store sync (`rz-push`/`rz-pull`). */
export interface BaseRequestConfig {
  /** The request URL. */
  url?: string;
  /** CSS selector for elements to receive the rouse request class for the duration of the request. */
  indicator?: string | null;
  /**
   * The element that initiated the request. Set by the declarative path; programmatic
   * requests leave it unset unless the caller supplies one.
   */
  triggerEl?: Element;
  /** Request headers. A `null` value removes the header. Empty strings are sent as-is. */
  headers?: Record<string, string | null>;
  /** Appended to the URL as query-string parameters. */
  params?: Record<
    string,
    string | number | boolean | null | undefined | string[] | number[]
  >;
  /** Skip all registered interceptors for this request. */
  skipInterceptors?: boolean;
  /** Abort the request after this many milliseconds. */
  timeout?: number;
  /** Requests sharing the same key cancel each other; the last one wins. */
  abortKey?: string | symbol;
}

/** Options for a fetch. */
export interface FetchConfig extends BaseRequestConfig {
  /** Request body. Plain objects/arrays are JSON-serialized; a `BodyInit` is sent as-is. */
  body?: BodyInit | Record<string, any> | any[] | null | undefined;
  /** Serialize and send this form's data as the request body. */
  form?: HTMLFormElement;
}

/** The final unified options object for a fetch. */
export type FetchRequest = Omit<RequestInit, 'body' | 'headers'> & FetchConfig;

/**
 * The authoring surface for a store push or pull. A push body is the store's own data
 * and a pull carries none, so `body` and `form` are absent by design. `method` is absent
 * too: push takes its verb from `SyncPolicy.pushMethod`, and pull is always `GET`.
 */
export type SyncRequest = Omit<RequestInit, 'body' | 'headers' | 'method'> &
  BaseRequestConfig;

/**
 * The callable fetch surface. The HTTP method comes from `options.method`,
 * defaulting to `GET`.
 */
export type RouseFetch = (
  resource: string,
  options?: FetchRequest,
) => Promise<RouseResponse>;

/** The enhanced response object returned by `ctx.fetch` and `request()`. */
export interface RouseResponse<T = any> {
  /** Parsed response body, or `null` on error or empty response. */
  data: T | null;
  /** Populated on non-OK responses or network failures; `null` on success. */
  error: RequestError | null;
  /** The raw `Response` object from `fetch`, or `null` for non-HTTP failures. */
  response: Response | null;
  /** Flattened response headers as a plain object, or `null` for non-HTTP failures. */
  headers: Record<string, string> | null;
  /** HTTP status code, or `null` for non-HTTP failures. */
  status: number | null;
  /** The resolved request config that produced this response. */
  config: FetchRequest;
  /** Server-supplied swap target override (`Rouse-Target` header), if present. */
  targetOverride?: string | null;
}

/** Runs before a request is sent. Return a modified config to override request options. */
export type RequestInterceptor = (
  config: FetchRequest,
) => FetchRequest | Promise<FetchRequest>;

/** Runs after a successful response is received. Return a modified value to override response data. */
export type ResponseInterceptor = (
  data: any,
  response: Response,
  config: FetchRequest,
) => any | Promise<any>;

/** Runs when a request fails. Return a modified error to override what propagates. */
export type ErrorInterceptor = (
  error: RequestError,
  config: FetchRequest,
) => RequestError | Promise<RequestError>;

/** The three points in the request lifecycle where interceptors can be registered. */
export type InterceptorPhase = 'request' | 'response' | 'error';

/**
 * A scope setup function. Receives a `ScopeCtx` and returns a `Scope` object
 * whose properties become the scope's reactive state and methods.
 *
 * @template P - The type of the params object.
 * @template E - The Element type.
 */
export type ScopeSetup<
  P extends Record<string, any> = Record<string, any>,
  E extends Element = HTMLElement,
> = (ctx: ScopeCtx<P, E>) => Scope;

/** Options for `app.on` and `ctx.on`: a trigger's modifiers, plus a caller abort signal. */
export type ListenerOptions = TriggerOptions & {
  /** Combined with the app or scope lifetime signal. Aborting removes the listeners. */
  signal?: AbortSignal;
};

/**
 * The overload shape shared by `app.on` and `ctx.on`. Listens on a default
 * target (the app root or the scope host) unless an `EventTarget` is passed
 * first. Modifiers, filters, and timing are passed as options, along with an
 * optional `AbortSignal` combined with the owner's lifetime signal. Returns a
 * teardown function.
 */
export type BoundOn = {
  <N extends string>(
    events: N | N[],
    callback: EventCallback<TriggerEvent<N>>,
    options?: ListenerOptions,
  ): VoidFn;
  <N extends string>(
    target: EventTarget,
    events: N | N[],
    callback: EventCallback<TriggerEvent<N>>,
    options?: ListenerOptions,
  ): VoidFn;
};

/**
 * The context object passed into every scope setup function.
 *
 * @template P - The type of the params object.
 * @template E - The Element type.
 */
export type ScopeCtx<
  P extends Record<string, any> = Record<string, any>,
  E extends Element = HTMLElement,
> = {
  /** Scope parameters injected via inline JSON, <script> id reference, or store reference. */
  params: P;
  /** The `rz-scope` element this scope is mounted on. */
  host: E;
  /** The root element passed to `RouseApp`. */
  appRoot: HTMLElement;
  /** Access to all registered stores. */
  stores: StoreManager;
  /** Aborted when the scope is destroyed. Use to clean up scope-defined subscriptions. */
  term: AbortSignal;
  /** Scoped `fetch` surface. Aborts on scope destroy. */
  fetch: RouseFetch;
  /**
   * Adds an event listener that is auto-removed when the scope is destroyed. Listens
   * on the scope host unless an `EventTarget` is passed first. Modifiers, filters, and
   * timing are passed as options, with an optional `AbortSignal` combined with the
   * scope's own (`term`). The programmatic twin of `rz-on`, with the same trigger
   * sources. Returns a teardown function.
   */
  on: BoundOn;
  /** Scan a newly added DOM subtree for directives and initialize them. */
  scan: (newNode: Element) => void;
};

/**
 * The context passed to handler functions: event handlers, one-way binding
 * formatters, and other scope/store methods.
 *
 * @template P - The type of the params object.
 * @template E - The Element type.
 */
export type HandlerCtx<P = Record<string, any>, E extends Element = HTMLElement> = {
  /** Handler parameters injected via inline JSON, <script> id reference, or store reference. */
  params: P;
  /** The element the directive is bound to. */
  el: E;
  /** The triggering DOM event, or a synthetic `CustomEvent` when the handler runs without one (e.g. a function used to compute a one-way binding value). */
  e: Event;
  /** Current `rz-render` loop context. Both fields are `null` outside a render instance, and `item` is `null` for item-less (boolean/number) modes. */
  render: { item: unknown; index: number | null };
};

/**
 * `HandlerCtx` for handlers bound inside an `rz-render` instance: the loop item
 * is typed, and `render` is guaranteed present (non-null).
 *
 * @template Item - The type of the render item.
 * @template P - The type of the params object.
 * @template E - The Element type.
 */
export type RenderHandlerCtx<
  Item,
  P = Record<string, any>,
  E extends Element = HTMLElement,
> = Omit<HandlerCtx<P, E>, 'render'> & {
  /** Current `rz-render` loop context. */
  render: { item: Item; index: number };
};
