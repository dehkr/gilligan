import type { RouseApp } from '../core/app';
import { err, warn } from '../core/diagnostics';
import { createKey } from '../core/keys';
import { isPlainObject } from '../core/state';
import { resolveStoreUrl } from '../core/store';
import { dispatch } from '../dom/events';
import { extractFieldValues } from '../dom/forms';
import type { RouseRequest, RouseResponse } from '../types';
import { PREVENTED, runRequestLifecycle } from './lifecycle';
import { request, resolveRequestConfig } from './request';
import { fallbackResponse, isFileType, isJsonType } from './response';

const abortKeys = new WeakMap<Element, string>();

/**
 * Handles the preparation, pacing, and execution of a network request.
 */
export async function handleFetch(
  el: Element,
  app: RouseApp,
  programmaticOpts: RouseRequest = {},
): Promise<RouseResponse> {
  try {
    return await executeFetch(el, app, programmaticOpts);
  } catch (error: any) {
    __DEV__ && err(`Error executing fetch on element:`, el, error);

    return fallbackResponse(
      programmaticOpts,
      error.message || 'Internal error',
      'INTERNAL_ERROR',
    );
  }
}

/**
 * Handles the complete lifecycle of a network request once timing
 * conditions (throttle/debounce) have been satisfied.
 *
 * @param el - The DOM element triggering the network request.
 * @param options - The sanitized request config passed to the network orchestrator.
 */
async function executeFetch(el: Element, app: RouseApp, options: RouseRequest) {
  const isFormEl = el instanceof HTMLFormElement;

  // If the element is removed while the network request is actively in the air
  if (!el.isConnected) {
    abortKeys.delete(el);
    return fallbackResponse(options, 'Element disconnected from DOM');
  }

  // Bail out if disabled
  if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') {
    return fallbackResponse(options, 'Element is disabled');
  }

  let url = options.url || null;
  if (url) {
    url = resolveStoreUrl(url, app.stores);
  }

  if (!url) {
    __DEV__ && warn('Invalid or missing URL for the fetch request.', el);
    return fallbackResponse(
      options,
      'Invalid or missing URL for the fetch request.',
      'INTERNAL_ERROR',
    );
  }

  const finalRequestInit = resolveRequestConfig(el, 'fetch', app);
  const formMethod = isFormEl ? el.getAttribute('method') : undefined;

  const method = (
    options.method || // rz-fetch
    finalRequestInit.method || // rz-request / rz-fetch-request
    formMethod || // form native attribute
    'GET'
  ).toUpperCase();

  const hasExplicitBody =
    finalRequestInit.body !== undefined || options.body !== undefined;

  // Process standalone inputs to build the body or modify URL
  if (!hasExplicitBody) {
    extractFieldValues(el, method, finalRequestInit);
  }

  // Auto-generate an abort key if one isn't provided to guarantee
  // an element can never have conflicting requests.
  let autoAbortKey = abortKeys.get(el);
  if (!autoAbortKey) {
    autoAbortKey = createKey('rz_abort_');
    abortKeys.set(el, autoAbortKey);
  }

  // Final unified config object
  const finalOptions: RouseRequest = {
    ...finalRequestInit,
    ...options,
    method,
    abortKey: options.abortKey || finalRequestInit.abortKey || autoAbortKey,
    form: !hasExplicitBody && isFormEl ? el : undefined,
  };

  const outcome = await runRequestLifecycle({
    el,
    root: app.root,
    prefix: 'rz:fetch',
    config: finalOptions,
    configDetail: { config: finalOptions, url, method },
    lifecycleDetail: { config: finalOptions },
    terminalDetail: (result) => result,
    run: async (handle) => {
      try {
        const result = await request(url, finalOptions, app);
        const rouseHeaders = extractRouseHeaders(result.headers);

        if (rouseHeaders.redirect) {
          abortKeys.delete(el);
          window.location.assign(rouseHeaders.redirect);
          return result;
        }

        // Native browser-followed redirect (e.g., expired session -> login page).
        // Server intent via Rouse-Redirect wins. Falls through to the redirected
        // short-circuit in the error block below.
        if (result.response?.redirected) {
          if (isSameOrigin(result.response.url)) {
            abortKeys.delete(el);
            window.location.assign(result.response.url);
            return result;
          }
          __DEV__ && warn(`Cross-origin redirect blocked: '${result.response.url}'.`);
          result.error = {
            message: 'Cross-origin redirect blocked',
            status: 'REDIRECTED',
          };
        }

        applyUrlChange(rouseHeaders.pushUrl, rouseHeaders.replaceUrl);

        if (rouseHeaders.target) {
          result.targetOverride = rouseHeaders.target;
        }

        handle.settle(result);

        if (result.error) {
          const s = result.error.status;
          if (s !== 'CANCELED' && s !== 'REDIRECTED' && result.response) {
            routePayload(el, result, 'error');
          }
          return result;
        }
        if (result.response) {
          routePayload(el, result, 'success');
        }
        return result;
      } catch (error: any) {
        const fallback = fallbackResponse(
          finalOptions,
          error.message || 'Internal Error',
          'INTERNAL_ERROR',
        );
        handle.settle(fallback);
        return fallback;
      }
    },
  });

  return outcome === PREVENTED
    ? fallbackResponse(finalOptions, 'Prevented by rz:fetch:config listener')
    : outcome;
}

/**
 * Dispatches the typed success sub-events (`:file` / `:json` / `:html`)
 * that drive JSON and HTML payload routing.
 */
function routePayload(el: Element, result: RouseResponse, type: 'success' | 'error') {
  const data = result.data;
  const prefix = `rz:fetch:${type}`;

  // Check for files (Blob/ArrayBuffer)
  if (isFileType(data)) {
    dispatch(el, `${prefix}:file`, result);
    return;
  }

  // Check for parsed JSON (POJO or Array). Store manager requires
  // parsed objects to merge state.
  if (Array.isArray(data) || isPlainObject(data)) {
    dispatch(el, `${prefix}:json`, result);
    return;
  }

  // Handle strings (HTML/Text)
  if (typeof data === 'string') {
    if (__DEV__) {
      const contentType = result.response?.headers.get('Content-Type') || '';
      if (isJsonType(contentType)) {
        warn(`Content-Type is JSON but data is a string. Defaulting to HTML.`);
      }
    }

    dispatch(el, `${prefix}:html`, result);
    return;
  }

  // Ignore null/undefined (e.g., 204 No Content), but warn on unhandled complex types
  __DEV__ &&
    data != null &&
    warn(`Unsupported payload: '${data?.constructor?.name || typeof data}'.`);
}

/**
 * Extracts the server-driven flow-control headers the fetch engine acts on.
 *
 * `Rouse-Trigger` is deliberately absent: it is consumed by `runRequestLifecycle`
 * for all three request families (fetch, push, pull), not just fetch.
 */
function extractRouseHeaders(headers: Record<string, string> | null) {
  return {
    redirect: headers?.['rouse-redirect'] || null,
    target: headers?.['rouse-target'] || null,
    pushUrl: headers?.['rouse-push-url'] || null,
    replaceUrl: headers?.['rouse-replace-url'] || null,
  };
}

/**
 * Applies a server-directed URL change via history.pushState / replaceState.
 * Rejects cross-origin URLs to defend against a compromised backend.
 */
function applyUrlChange(pushUrl: string | null, replaceUrl: string | null): void {
  const url = pushUrl ?? replaceUrl;
  if (url === null) return;

  __DEV__ &&
    pushUrl &&
    replaceUrl &&
    warn(`Both 'Rouse-Push-Url' and 'Rouse-Replace-Url' present. Using Push.`);

  if (!isSameOrigin(url)) {
    const headerName = pushUrl ? 'Rouse-Push-Url' : 'Rouse-Replace-Url';
    __DEV__ && warn(`'${headerName}' rejected: cross-origin URL '${url}'.`);
    return;
  }

  const method = pushUrl ? 'pushState' : 'replaceState';

  try {
    history[method]({}, '', url);
  } catch (error) {
    __DEV__ && warn(`${method} failed for URL '${url}'.`, error);
  }
}

function isSameOrigin(url: string): boolean {
  try {
    return new URL(url, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}
