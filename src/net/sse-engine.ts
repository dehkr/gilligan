import type { RouseApp } from '../core/app';
import { dispatch } from '../core/dispatch';
import { safeJSONParse } from '../core/parser';
import { isPlainObject } from '../core/state';
import type {
  LifecycleEventMap,
  SseCloseReason,
  SseConnectionConfig,
  SseOptions,
} from '../types';
import { resolveUrl } from './payload';

/** Releases one reference to a stream. Assignable to `VoidFn`. */
export type SseRelease = (reason?: SseCloseReason) => void;

/** One holder of a stream: a directive binding, or an `app.sse` / `ctx.sse` call. */
interface StreamRef {
  /** Dispatch node for this holder's events, and the `rz-target` host. */
  el: Element;
  config: SseConnectionConfig;
}

interface StreamEntry {
  url: string;
  withCredentials: boolean;
  source: EventSource | null;
  refs: Set<StreamRef>;
  /** Named events already wired to `source`; cleared whenever a new source is built. */
  attached: Set<string>;
  /** Consecutive failed attempts. Reset on every open. */
  attempt: number;
  /** Ended and will not reopen. A joining reference does not revive it. */
  closed: boolean;
}

const DEFAULT_EVENT = 'message';

const entries = new Map<string, StreamEntry>();
const subscribedNames = new Set<string>();

function streamKey(url: string, withCredentials: boolean) {
  return `${withCredentials ? '1' : '0'}|${url}`;
}

/**
 * Opens a stream, or joins one already open at the same URL. Fires `rz:sse:config`
 * first; a listener that cancels it gets an inert release and no connection.
 *
 * @param revive - Whether to reopen a permanently closed connection. Programmatic
 * callers do; a mounting element does not, so it can't override a listener's cancel.
 * @returns A release for this holder's reference, idempotent after the first call.
 */
export function openStream(
  app: RouseApp,
  resource: string,
  options: SseOptions = {},
  revive = false,
): SseRelease | null {
  const el = options.triggerEl ?? app.root;

  const config: SseConnectionConfig = {
    url: resolveUrl(resource, app.config.baseUrl).href,
    withCredentials: options.withCredentials ?? false,
    triggerEl: options.triggerEl,
  };

  // Cancelable, and the one chance to rewrite the endpoint: the key is read back
  // from `config` afterwards, so a mutated URL is the one that connects.
  const gate = dispatch(el, 'rz:sse:config', { config }, { cancelable: true });
  if (gate.defaultPrevented) {
    return null;
  }

  const key = streamKey(config.url, config.withCredentials);
  let entry = entries.get(key);

  if (!entry) {
    entry = {
      url: config.url,
      withCredentials: config.withCredentials,
      source: null,
      refs: new Set(),
      attached: new Set(),
      attempt: 0,
      closed: false,
    };
    entries.set(key, entry);
  }

  const ref: StreamRef = { el, config };
  entry.refs.add(ref);

  if (!entry.source && (!entry.closed || revive)) {
    entry.attempt = 0;
    connect(entry);
  } else if (entry.source?.readyState === EventSource.OPEN) {
    // A ref joining a live stream missed the connect dispatch
    dispatch(el, 'rz:sse:open', { config });
  }

  return (reason = 'released') => release(key, ref, reason);
}

/**
 * Subscribes every current and future connection to a named server event. Called
 * by the `sse` trigger source, so a directive declares nothing about which names
 * a stream carries.
 */
export function subscribeNamed(name: string): void {
  if (!name || name === DEFAULT_EVENT || subscribedNames.has(name)) return;

  subscribedNames.add(name);
  entries.forEach((entry) => attachNamed(entry, name));
}

function connect(entry: StreamEntry) {
  const source = new EventSource(entry.url, {
    withCredentials: entry.withCredentials,
  });

  entry.source = source;
  entry.closed = false;
  entry.attached = new Set();

  source.addEventListener('open', () => {
    entry.attempt = 0;
    emit(entry, 'rz:sse:open', {});
  });

  source.addEventListener('error', () => onError(entry));

  attachNamed(entry, DEFAULT_EVENT);
  subscribedNames.forEach((name) => attachNamed(entry, name));
}

function attachNamed(entry: StreamEntry, name: string) {
  const { source } = entry;
  if (!source || entry.attached.has(name)) return;

  entry.attached.add(name);
  source.addEventListener(name, (e) => onMessage(entry, name, e as MessageEvent));
}

function onMessage(entry: StreamEntry, event: string, e: MessageEvent) {
  const raw = typeof e.data === 'string' ? e.data : String(e.data);
  const data = parseMessageData(raw);

  for (const ref of entry.refs) {
    const base = { config: ref.config, event, raw, lastEventId: e.lastEventId };

    // Routing before the trigger source, so an `sse-[name]` handler observes the
    // DOM already swapped. The sub-event leading its parent is deliberate.
    if (Array.isArray(data) || isPlainObject(data)) {
      dispatch(ref.el, 'rz:sse:message:json', { ...base, data });
    } else {
      dispatch(ref.el, 'rz:sse:message:html', { ...base, data: raw });
    }

    dispatch(ref.el, 'rz:sse:message', { ...base, data });
  }
}

/**
 * The browser schedules its own retry before this runs, and exposes no hook to
 * intercept it — so a prevented event closes the connection instead.
 */
function onError(entry: StreamEntry) {
  const { source } = entry;
  if (!source) return;

  entry.attempt += 1;

  // CLOSED here means the server rejected the connection outright (non-200 or a
  // wrong content type), which the platform never retries.
  const willRetry = source.readyState !== EventSource.CLOSED;
  const prevented = emit(entry, 'rz:sse:error', { attempt: entry.attempt }, true);

  if (!willRetry) {
    finalize(entry, 'failed');
  } else if (prevented) {
    finalize(entry, 'canceled');
  }
}

/** Ends the connection while its references remain, so the refcount stays sound. */
function finalize(entry: StreamEntry, reason: SseCloseReason) {
  entry.source?.close();
  entry.source = null;
  entry.attached.clear();
  entry.closed = true;

  emit(entry, 'rz:sse:close', { reason });
}

function release(key: string, ref: StreamRef, reason: SseCloseReason) {
  const entry = entries.get(key);
  if (!entry?.refs.delete(ref)) return;

  // `finalize` already announced a permanent close to every holder
  const announced = entry.closed;

  if (entry.refs.size === 0) {
    entry.source?.close();
    entries.delete(key);
  }

  if (!announced) {
    dispatch(ref.el, 'rz:sse:close', { config: ref.config, reason });
  }
}

/**
 * Dispatches one connection event from every holder's element. Returns whether any
 * holder canceled it.
 */
function emit<E extends 'rz:sse:open' | 'rz:sse:error' | 'rz:sse:close'>(
  entry: StreamEntry,
  name: E,
  detail: Omit<LifecycleEventMap[E], 'config'>,
  cancelable = false,
): boolean {
  let prevented = false;

  for (const ref of entry.refs) {
    const event = dispatch(ref.el, name, { config: ref.config, ...detail } as any, {
      cancelable,
    });
    prevented ||= event.defaultPrevented;
  }

  return prevented;
}

/**
 * Parses a message body as JSON only when it looks like an object or array, so a
 * bare `123` or `true` stays the string the HTML path expects.
 */
function parseMessageData(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return raw;

  try {
    return safeJSONParse(trimmed);
  } catch {
    return raw;
  }
}
