import type { RouseApp } from '../core/app';
import { HTTP_METHODS, type HttpMethod } from '../core/constants';
import { warn } from '../core/diagnostics';
import {
  rzFetchHeaders,
  rzHeaders,
  rzPullHeaders,
  rzPushHeaders,
} from '../directives/headers-config';
import {
  rzFetchRequest,
  rzPullRequest,
  rzPushRequest,
  rzRequest,
} from '../directives/request-config';
import type {
  NetworkAction,
  RequestError,
  RouseFetch,
  RouseRequest,
  RouseResponse,
} from '../types';
import { preparePayload } from './payload';
import { fallbackResponse, mapCatchError, normalizeResponse } from './response';

interface AbortEntry {
  controller: AbortController;
  ownerId: symbol;
}

type BaseFetch = (resource: string, options?: RouseRequest) => Promise<RouseResponse>;

const REQUEST_VARIANTS = {
  fetch: rzFetchRequest,
  push: rzPushRequest,
  pull: rzPullRequest,
} as const;

const HEADERS_VARIANTS = {
  fetch: rzFetchHeaders,
  push: rzPushHeaders,
  pull: rzPullHeaders,
} as const;

const abortRegistry = new Map<string | symbol, AbortEntry>();

/**
 * A wrapper for the Fetch API providing request orchestration, including:
 *
 *   - Request, response, and error interceptors
 *   - Automatic payload serialization (JSON, FormData, URL parameters)
 *   - Concurrency management and cancellation via `abortKey`
 *   - Absolute global request timeouts
 *   - Configurable retries with custom delays and native 429/503 `Retry-After` support
 *   - Automatic response normalization (JSON, Text, Blob)
 */
export async function request<T = any>(
  url: string,
  options: RouseRequest = {},
  app: RouseApp,
): Promise<RouseResponse<T>> {
  let currentOptions = { ...options };

  if (!currentOptions.skipInterceptors) {
    try {
      for (const fn of app._interceptors.request) {
        currentOptions = await fn(currentOptions);
      }
    } catch (e: unknown) {
      let errorPayload = mapCatchError(e, false);
      for (const fn of app._interceptors.error) {
        errorPayload = await fn(errorPayload, currentOptions);
      }
      return wrapErrorResponse(errorPayload, currentOptions);
    }
  }

  const { finalUrl, method, reqHeaders, finalBody, restOptions } = preparePayload(
    url,
    currentOptions,
    app.config.baseUrl,
  );

  // Enforce no body on GET/HEAD
  let safeBody: BodyInit | null | undefined = finalBody;

  if ((method === 'GET' || method === 'HEAD') && safeBody != null) {
    __DEV__ && warn('Body is not allowed on GET or HEAD.');
    safeBody = undefined;
  }

  // Extract Rouse-specific execution options
  const {
    retry = 0,
    timeout = 0,
    abortKey,
    triggerEl,
    signal: externalSignal,
    method: _method,
    ...fetchOptions
  } = restOptions;

  let mainSignal: AbortSignal | null = null;
  let ownerId: symbol | null = null;

  // Handle concurrency and establish the primary abort signal
  if (abortKey) {
    abortRegistry.get(abortKey)?.controller.abort('Replacement request started');
    const controller = new AbortController();
    ownerId = Symbol('rz.abortOwner');
    abortRegistry.set(abortKey, { controller, ownerId });
    mainSignal = controller.signal;
  } else if (externalSignal) {
    mainSignal = externalSignal;
  }

  const signals = [mainSignal, timeout > 0 ? AbortSignal.timeout(timeout) : null].filter(
    (s): s is AbortSignal => s !== null,
  );

  const combinedSignal = AbortSignal.any(signals);

  const execute = async (attempt: number): Promise<RouseResponse<T>> => {
    if (combinedSignal.aborted) {
      const status = mainSignal?.aborted ? 'CANCELED' : 'TIMEOUT';
      return fallbackResponse(currentOptions, 'Request canceled or timed out', status);
    }

    try {
      const response = await fetch(finalUrl, {
        method,
        headers: reqHeaders,
        signal: combinedSignal,
        ...fetchOptions,
        ...(safeBody != null ? { body: safeBody } : {}),
      });

      // If the server is overloaded (503) or if rate-limited (429),
      // check the 'Retry-After' header to avoid further hammering the server.
      if (!response.ok && (response.status === 429 || response.status === 503)) {
        const delay = getRetryDelay(attempt, retry, currentOptions, response);
        if (delay !== null) {
          await cancellableDelay(delay, combinedSignal);
          return execute(attempt + 1);
        }
      }

      const normalized = await normalizeResponse(response, currentOptions);

      // Run response/error interceptors
      if (!currentOptions.skipInterceptors) {
        if (normalized.error) {
          for (const fn of app._interceptors.error) {
            normalized.error = await fn(normalized.error, currentOptions);
          }
        } else {
          for (const fn of app._interceptors.response) {
            normalized.data = await fn(
              normalized.data,
              normalized.response as Response,
              currentOptions,
            );
          }
        }
      }
      return normalized;
    } catch (err: any) {
      let errorPayload = mapCatchError(err, !!mainSignal?.aborted);

      if (errorPayload.status !== 'CANCELED' && errorPayload.status !== 'TIMEOUT') {
        const delay = getRetryDelay(attempt, retry, currentOptions);
        if (delay !== null) {
          await cancellableDelay(delay, combinedSignal);
          return execute(attempt + 1);
        }
      }

      // Error interceptors run on the final failure or explicit cancellation
      if (!currentOptions.skipInterceptors) {
        for (const fn of app._interceptors.error) {
          errorPayload = await fn(errorPayload, currentOptions);
        }
      }

      return wrapErrorResponse(errorPayload, currentOptions);
    }
  };

  try {
    return await execute(0);
  } finally {
    // Cleanup abort key mapping only if this request owns it
    if (abortKey && ownerId) {
      const entry = abortRegistry.get(abortKey);
      if (entry?.ownerId === ownerId) {
        abortRegistry.delete(abortKey);
      }
    }
  }
}

/**
 * Resolves the final network configuration by merging app-level defaults with
 * directive-driven config layers in priority order (later wins):
 *
 *   1. global defaults (`app.config.*`)
 *   2. `rz-request` on target element (push/pull only)
 *   3. `rz-<push|pull>-request` on target element (push/pull only)
 *   4. `rz-request` on triggering element
 *   5. `rz-<action>-request` on triggering element
 *
 * Headers follow the same chain, merged separately so per-key overrides win
 * without losing unrelated header keys from earlier layers.
 *
 * `targetEl` applies to push/pull, where the action is initiated by one
 * element but configured on another (the store's owning element).
 */
export function resolveRequestConfig(
  triggeringEl: Element,
  action: NetworkAction,
  app: RouseApp,
  targetEl?: Element,
): Partial<RouseRequest> {
  const globalConfig: Partial<RouseRequest> = {
    headers: app.config.headers,
    credentials: app.config.credentials,
  };
  const requestVariant = REQUEST_VARIANTS[action];
  const headersVariant = HEADERS_VARIANTS[action];

  const layers: Partial<RouseRequest>[] = [];
  const headerLayers: (Record<string, string | null> | undefined)[] = [];

  const addLayer = (cfg: Partial<RouseRequest>) => {
    layers.push(cfg);
    if (cfg.headers) {
      headerLayers.push(cfg.headers);
    }
  };

  const addHeaders = (hdrs: Record<string, string | null>) => {
    if (Object.keys(hdrs).length > 0) {
      headerLayers.push(hdrs);
    }
  };

  addLayer(globalConfig);

  const applyConfig = (el: Element) => {
    addLayer(rzRequest.getConfig(el, app));
    addHeaders(rzHeaders.getConfig(el, app));
    addLayer(requestVariant.getConfig(el, app));
    addHeaders(headersVariant.getConfig(el, app));
  };

  if (targetEl && targetEl !== triggeringEl) {
    applyConfig(targetEl);
  }
  applyConfig(triggeringEl);

  const merged = Object.assign({}, ...layers) as Partial<RouseRequest>;
  merged.headers = Object.assign({}, ...headerLayers);

  return merged;
}

/**
 * Attach lowercased HTTP-method aliases (`fetch.get`, `fetch.post`, etc.) to a base
 * fetch. Each forwards to the base with `method` pinned. The alias wins over any
 * `method` in the passed options.
 */
export function withMethodAliases(base: BaseFetch): RouseFetch {
  const fetch = base as RouseFetch;
  for (const method of HTTP_METHODS) {
    fetch[method.toLowerCase() as Lowercase<HttpMethod>] = (resource, options) =>
      base(resource, { ...options, method });
  }
  return fetch;
}

/**
 * Wrap a `RequestError` into a `RouseResponse`.
 */
function wrapErrorResponse(error: RequestError, options: RouseRequest) {
  return {
    data: null,
    error,
    response: null,
    headers: null,
    status: null,
    config: options,
  };
}

/**
 * Parses a Retry-After header (seconds or HTTP-Date) into milliseconds.
 * Caps the maximum delay at 60 seconds.
 */
function parseRetryAfter(header: string | null): number {
  let waitMs = 1000;

  if (header) {
    if (/^\d+$/.test(header)) {
      waitMs = parseInt(header, 10) * 1000;
    } else {
      const date = Date.parse(header);
      if (!Number.isNaN(date)) {
        waitMs = date - Date.now();
      }
    }
  }

  return Math.max(0, Math.min(waitMs, 60000));
}

/**
 * Determines whether a failed request should be retried and how long to wait.
 * Returns the delay in ms, or null if the request should not be retried.
 */
function getRetryDelay(
  attempt: number,
  maxRetries: number,
  options: RouseRequest,
  response?: Response,
): number | null {
  if (attempt >= maxRetries) return null;

  // Server-driven delay from a 429/503 Retry-After header takes precedence.
  // The caller only passes `response` on the overload path, so presence is enough.
  if (response) {
    const serverDelay = response.headers.get('Retry-After');
    if (serverDelay) {
      return parseRetryAfter(serverDelay);
    }
  }

  // User-defined delay for network/catch errors
  const delayConfig = options.retryDelay ?? 1000;
  return typeof delayConfig === 'function' ? delayConfig(attempt) : delayConfig;
}

/**
 * Resolves a delay promise early if the provided signal is aborted.
 */
function cancellableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();

  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };

    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    signal.addEventListener('abort', onAbort, { once: true });
  });
}
