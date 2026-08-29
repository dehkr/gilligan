import type { RouseApp } from '../core/app';
import { warn } from '../core/diagnostics';
import { rzFetchInit } from '../directives/rz-fetch-init';
import { rzHeaders } from '../directives/rz-headers';
import type { FetchRequest, RequestError, RouseResponse } from '../types';
import { preparePayload } from './payload';
import { fallbackResponse, mapCatchError, normalizeResponse } from './response';

interface AbortEntry {
  controller: AbortController;
  ownerId: symbol;
}

const abortRegistry = new Map<string | symbol, AbortEntry>();

/**
 * Issues a network request and normalizes the outcome.
 *
 * The single path every request Rouse makes goes through: the fetch engine and
 * `StoreManager._request` both route through it, which is what makes interceptors
 * apply uniformly (`skipInterceptors` is the per-call opt-out). Handles payload
 * serialization, `abortKey` concurrency, timeouts, and response normalization.
 *
 * A `GET` or `HEAD` that fails before any HTTP response arrives is retried once,
 * immediately. That covers a dropped keep-alive socket or a network handoff, where
 * nothing reached the server and so nothing can be duplicated. The retry happens
 * below the lifecycle and above the error chain, so one failure still produces one
 * terminal event and one interceptor pass. `TIMEOUT` and `CANCELED` are never
 * retried, and neither is any other method.
 */
export async function request<T = any>(
  url: string,
  options: FetchRequest = {},
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

  const execute = async (attempt = 0): Promise<RouseResponse<T>> => {
    if (combinedSignal.aborted) {
      const status = mainSignal?.aborted ? 'CANCELED' : 'TIMEOUT';
      return fallbackResponse(currentOptions, 'Request canceled or timed out', status);
    }

    let responded = false;

    try {
      const response = await fetch(finalUrl, {
        method,
        headers: reqHeaders,
        signal: combinedSignal,
        ...fetchOptions,
        ...(safeBody != null ? { body: safeBody } : {}),
      });
      responded = true;

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

      // One immediate retry for idempotent reads. `!responded` is what makes this a
      // transport check: NETWORK_ERROR is `mapCatchError`'s fallback for any non-abort
      // throw, including one from a response interceptor, which must not re-send.
      // TIMEOUT and CANCELED are excluded since both are deadlines someone set on purpose.
      if (
        !responded &&
        attempt === 0 &&
        errorPayload.status === 'NETWORK_ERROR' &&
        (method === 'GET' || method === 'HEAD')
      ) {
        return execute(attempt + 1);
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
 * Resolves the final network configuration for a fetch by merging app-level
 * defaults with directive-driven config layers in priority order (later wins):
 *
 *   1. global defaults (`app.config.*`)
 *   2. `rz-fetch-init` and `rz-headers` on the triggering element
 *
 * Headers follow the same chain, merged separately so per-key overrides win
 * without losing unrelated header keys from earlier layers.
 *
 * A `null` `triggerEl` is a programmatic request with no originating element:
 * only the global layer applies. Push and pull do not come through here — their
 * config lives on the store.
 */
export function resolveRequestConfig(
  triggerEl: Element | null,
  app: RouseApp,
): Partial<FetchRequest> {
  const config: Partial<FetchRequest> = {
    credentials: app.config.credentials,
    timeout: app.config.timeout,
    ...(triggerEl ? rzFetchInit.getConfig(triggerEl) : {}),
  };

  config.headers = {
    ...app.config.headers,
    ...(triggerEl ? rzHeaders.getConfig(triggerEl) : {}),
  };

  return config;
}

/**
 * Wrap a `RequestError` into a `RouseResponse`.
 */
function wrapErrorResponse(error: RequestError, options: FetchRequest) {
  return {
    data: null,
    error,
    response: null,
    headers: null,
    status: null,
    config: options,
  };
}
