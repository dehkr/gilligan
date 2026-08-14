import type { RouseApp } from '../core/app';
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
import type { NetworkAction, RequestError, RouseRequest, RouseResponse } from '../types';
import { preparePayload } from './payload';
import { fallbackResponse, mapCatchError, normalizeResponse } from './response';

interface AbortEntry {
  controller: AbortController;
  ownerId: symbol;
}

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
 * Issues a network request and normalizes the outcome.
 *
 * The single path every request Rouse makes goes through: the fetch engine and
 * `StoreManager._request` both route through it, which is what makes interceptors
 * apply uniformly (`skipInterceptors` is the per-call opt-out). Handles payload
 * serialization, `abortKey` concurrency, timeouts, and response normalization.
 *
 * Does not reject on failure: network errors and non-OK statuses resolve as a
 * `RouseResponse` with `error` populated. Malformed config is the exception, since
 * `preparePayload` runs outside the catch and throws on an unusable URL or a
 * `body`/`form` conflict.
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

  // Extract Rouse-specific execution options
  const {
    timeout = 0,
    abortKey,
    triggerEl,
    signal: externalSignal,
    method: _method,
    ...fetchOptions
  } = restOptions;

  // Enforce no body on GET/HEAD
  let safeBody: BodyInit | null | undefined = finalBody;

  if ((method === 'GET' || method === 'HEAD') && safeBody != null) {
    __DEV__ && warn('Body is not allowed on GET or HEAD.', triggerEl);
    safeBody = undefined;
  }

  let mainSignal: AbortSignal | null = null;
  let ownerId: symbol | null = null;

  // Handle concurrency and establish the primary abort signal
  if (abortKey) {
    abortRegistry.get(abortKey)?.controller.abort('Replacement request started');
    const controller = new AbortController();
    ownerId = Symbol(__DEV__ ? 'rz.abortOwner' : '');
    abortRegistry.set(abortKey, { controller, ownerId });
    mainSignal = controller.signal;
  } else if (externalSignal) {
    mainSignal = externalSignal;
  }

  const signals = [mainSignal, timeout > 0 ? AbortSignal.timeout(timeout) : null].filter(
    (s): s is AbortSignal => s !== null,
  );

  const combinedSignal = AbortSignal.any(signals);

  const execute = async (): Promise<RouseResponse<T>> => {
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
    return await execute();
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
 * `targetEl` applies to push/pull, where the action is initiated by one element but
 * configured on another (the store's owning element). A `null` `triggerEl` is a
 * programmatic request with no originating element: only the global layer applies.
 */
export function resolveRequestConfig(
  triggerEl: Element | null,
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

  if (targetEl && targetEl !== triggerEl) {
    applyConfig(targetEl);
  }
  if (triggerEl) {
    applyConfig(triggerEl);
  }

  const merged = Object.assign({}, ...layers) as Partial<RouseRequest>;
  merged.headers = Object.assign({}, ...headerLayers);

  return merged;
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
