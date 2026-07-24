import { getApp, type RouseApp } from '../core/app';
import { getDirectiveValue, hasDirective } from '../core/attributes';
import { type HttpMethod, isHttpMethod } from '../core/constants';
import { err, warn } from '../core/diagnostics';
import { is } from '../core/is';
import type { SyncConfig } from '../core/store';
import type { StoreDirective } from '../types';
import { rzPullRequest, rzPushRequest, rzRequest } from './request-config';
import { rzUrl } from './rz-url';

const initialized = new WeakSet<HTMLScriptElement>();

/**
 * Bootstraps a global reactive store from a `<script>` tag. Initializes the
 * reactive data registry and seeds the store's URL from `rz-url` if present.
 *
 * Push/pull triggers (`rz-push`, `rz-pull`) are wired separately, so the
 * store doesn't need to know about them.
 */
function initialize(el: HTMLScriptElement, app: RouseApp) {
  if (initialized.has(el)) return;

  const storeName = getDirectiveValue(el, 'store')?.trim();
  if (!storeName) return;

  const textContent = el.textContent?.trim();
  const storeExists = app.stores.has(storeName);

  // If the store was already created programmatically and this `<script>` has
  // no JSON, we skip defining state and move on to attaching the network directives.
  // If the programmatic store exists and the script contains JSON, however, the
  // programmatic data gets replaced.
  if (textContent || !storeExists) {
    let state: any;
    try {
      state = JSON.parse(textContent || '{}');
    } catch (error) {
      __DEV__ && err(`rz-store: invalid JSON in store '${storeName}'.`, el, error);
      return;
    }

    if (storeExists) {
      app.stores.update(storeName, state);
    } else {
      app.stores.create(storeName, state, undefined, el);
    }
  }

  const cfg: Partial<SyncConfig> = {};

  // Seed the store URL from `rz-url`
  if (hasDirective(el, 'url')) {
    const { url } = rzUrl.getConfig(el);
    if (url) cfg.url = url;
  }

  // Capture declarative rollback config for store-level default
  const reqBase = rzRequest.getConfig(el, app);
  const reqPush = rzPushRequest.getConfig(el, app);
  const reqPull = rzPullRequest.getConfig(el, app);

  const pushMethod = resolveMethod(reqPush.method ?? reqBase.method, el);
  const pullMethod = resolveMethod(reqPull.method ?? reqBase.method, el);

  if (pushMethod) cfg.pushMethod = pushMethod;
  if (pullMethod) cfg.pullMethod = pullMethod;

  const rollbackOnError = reqPush.rollbackOnError ?? reqBase.rollbackOnError;
  if (rollbackOnError !== undefined) {
    cfg.rollbackOnError = rollbackOnError;
  }

  if (Object.keys(cfg).length) {
    app.stores.config(storeName, cfg);
  }

  initialized.add(el);
}

/**
 * Checks for a valid HTTP method and normalizes it to uppercase.
 */
function resolveMethod(method: string | undefined, el: Element): HttpMethod | undefined {
  if (method == null) return undefined;
  if (!isHttpMethod(method)) {
    __DEV__ && warn(`rz-store: unknown HTTP method '${method}'. Ignoring.`, el);
    return undefined;
  }

  return method.toUpperCase() as HttpMethod;
}

/**
 * Validates if `el` is a script element hosting an `rz-store` directive with a value.
 */
function validate(el: Element, app: RouseApp): el is HTMLScriptElement {
  if (!(is(el, 'Script') && hasDirective(el, 'store') && getApp(el, app))) {
    return false;
  }
  if (!getDirectiveValue(el, 'store')?.trim()) {
    __DEV__ && warn(`rz-store: value is missing or empty.`, el);
    return false;
  }

  return true;
}

function teardown(el: HTMLScriptElement) {
  initialized.delete(el);
}

export const rzStore = {
  slug: 'store',
  validate,
  initialize,
  teardown,
} as const satisfies StoreDirective;
