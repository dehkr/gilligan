import type { RouseApp } from '../core/app';
import { err, warn } from '../core/diagnostics';
import { createKey } from '../core/keys';
import { isPlainObject } from '../core/state';
import { dispatch } from '../dom/events';
import { extractFieldValues } from '../dom/forms';
import type { RouseRequest, RouseResponse } from '../types';
import { type LifecycleHandle, PREVENTED, runRequestLifecycle } from './lifecycle';
import { request, resolveRequestConfig } from './request';
import { fallbackResponse, isFileType, isJsonType } from './response';

const abortKeys = new WeakMap<Element, string>();

/**
 * Runs a fetch. Resolves the URL and merged request config, drives the `rz:fetch:*`
 * lifecycle, and routes the response payload. A failure comes back as a `RouseResponse`
 * carrying an error.
 *
 * `options.triggerEl` is the element the request originates from, set by the declarative
 * path. It gates everything element-derived: config attributes, field extraction, the
 * disabled guard, and the abort key. It's the node the lifecycle events fire from. A
 * programmatic fetch doesn't have a triggerEl, but it can be set manually via config.
 */
export async function runFetch(
  app: RouseApp,
  options: RouseRequest,
): Promise<RouseResponse> {
  const triggerEl = options.triggerEl ?? null;
  // Lifecycle events always need a node to fire from, triggerEl or not
  const hostEl = triggerEl ?? app.root;

  try {
    if (triggerEl) {
      // A debounced or queued trigger can fire after the element is gone
      if (!triggerEl.isConnected) {
        abortKeys.delete(triggerEl);
        return fallbackResponse(options, 'Element disconnected from DOM');
      }

      // Bail out if disabled
      if (
        triggerEl.hasAttribute('disabled') ||
        triggerEl.getAttribute('aria-disabled') === 'true'
      ) {
        return fallbackResponse(options, 'Element is disabled');
      }
    }

    const url = resolveUrl(triggerEl, options);
    if (!url) {
      return fallbackResponse(
        options,
        'Invalid or missing URL for the fetch request.',
        'INTERNAL_ERROR',
      );
    }

    const finalRequestInit = resolveRequestConfig(triggerEl, app);
    const isFormEl = triggerEl instanceof HTMLFormElement;
    const formMethod = isFormEl ? triggerEl.getAttribute('method') : undefined;

    // Prioritization: rz-fetch > rz-request > form attribute > 'GET'
    const method = (
      options.method ||
      finalRequestInit.method ||
      formMethod ||
      'GET'
    ).toUpperCase();

    const hasExplicitBody =
      finalRequestInit.body !== undefined || options.body !== undefined;

    // Process standalone inputs to build the body or modify URL
    if (triggerEl && !hasExplicitBody) {
      extractFieldValues(triggerEl, method, finalRequestInit);
    }

    // Final unified config object
    const finalOptions: RouseRequest = {
      ...finalRequestInit,
      ...options,
      method,
      // Programmatic headers merge per key with the resolved declarative layers,
      // matching how those layers combine with each other. `null` removes one.
      headers: { ...finalRequestInit.headers, ...options.headers },
      // No `triggerEl` means no element to key on, so a programmatic caller opts
      // into deduping by setting the `abortKey` option.
      abortKey:
        options.abortKey ||
        finalRequestInit.abortKey ||
        (triggerEl ? getAbortKey(triggerEl) : undefined),
      form: !hasExplicitBody && isFormEl ? triggerEl : undefined,
    };

    const outcome = await runRequestLifecycle({
      el: hostEl,
      root: app.root,
      prefix: 'rz:fetch',
      configDetail: { config: finalOptions, url, method },
      terminalDetail: (result) => result,
      run: (handle) => sendAndRoute(hostEl, triggerEl, url, finalOptions, app, handle),
    });

    return outcome === PREVENTED
      ? fallbackResponse(finalOptions, 'Prevented by rz:fetch:config listener')
      : outcome;
  } catch (error: any) {
    __DEV__ && err(`Error executing fetch:`, ...(triggerEl ? [triggerEl] : []), error);

    return fallbackResponse(options, error.message || 'Internal error', 'INTERNAL_ERROR');
  }
}

/**
 * Sends the request and routes what comes back: server-directed redirects and
 * URL changes first, then the payload to its typed sub-event. Events fire from
 * `hostEl`; `triggerEl` is used only for abort-key bookkeeping.
 */
async function sendAndRoute(
  hostEl: Element,
  triggerEl: Element | null,
  url: string,
  options: RouseRequest,
  app: RouseApp,
  handle: LifecycleHandle,
): Promise<RouseResponse> {
  try {
    const result = await request(url, options, app);
    const rouseHeaders = extractRouseHeaders(result.headers);

    if (rouseHeaders.redirect) {
      followRedirect(triggerEl, rouseHeaders.redirect);
      return result;
    }

    // Native browser-followed redirect (e.g., expired session -> login page).
    // Server intent via Rouse-Redirect wins. Falls through to the redirected
    // short-circuit in the error block below.
    if (result.response?.redirected) {
      if (isSameOrigin(result.response.url)) {
        followRedirect(triggerEl, result.response.url);
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
        routePayload(hostEl, result, 'error');
      }
      return result;
    }
    if (result.response) {
      routePayload(hostEl, result, 'success');
    }
    return result;
  } catch (error: any) {
    const fallback = fallbackResponse(
      options,
      error.message || 'Internal Error',
      'INTERNAL_ERROR',
    );
    handle.settle(fallback);
    return fallback;
  }
}

/**
 * Returns the request URL from the options. Warns against `el` and returns `null`
 * when there is none.
 */
function resolveUrl(el: Element | null, options: RouseRequest): string | null {
  if (!options.url) {
    __DEV__ && warn('Invalid or missing URL for the fetch request.', ...(el ? [el] : []));
    return null;
  }

  return options.url;
}

/** Navigates to a server-directed redirect target. */
function followRedirect(el: Element | null, url: string): void {
  if (el) {
    abortKeys.delete(el);
  }
  window.location.assign(url);
}

/**
 * Returns the element's abort key, generating one on first use so an element can
 * never have conflicting requests in the air.
 */
function getAbortKey(el: Element): string {
  let key = abortKeys.get(el);

  if (!key) {
    key = createKey('rz_abort_');
    abortKeys.set(el, key);
  }

  return key;
}

/**
 * Dispatches the typed payload sub-event (`:file` / `:json` / `:html`) under the
 * given `rz:fetch:{success,error}` prefix, driving JSON and HTML routing.
 */
function routePayload(hostEl: Element, result: RouseResponse, type: 'success' | 'error') {
  const data = result.data;
  const prefix = `rz:fetch:${type}`;

  // Check for files (Blob/ArrayBuffer)
  if (isFileType(data)) {
    dispatch(hostEl, `${prefix}:file`, result);
    return;
  }

  // Check for parsed JSON (POJO or Array). Store manager requires parsed objects
  // to merge state.
  if (Array.isArray(data) || isPlainObject(data)) {
    dispatch(hostEl, `${prefix}:json`, result);
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

    dispatch(hostEl, `${prefix}:html`, result);
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

/**
 * Resolves `url` against the document and compares origins. Malformed URLs
 * are not same-origin.
 */
function isSameOrigin(url: string): boolean {
  try {
    return new URL(url, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}
