import type { RouseApp } from '../core/app';
import { directiveSelector, getDirectiveValue } from '../core/attributes';
import {
  type HttpMethod,
  isHttpMethod,
  isPatchAction,
  type PatchAction,
} from '../core/constants';
import { err, warn } from '../core/diagnostics';
import type { SyncPolicy } from '../core/store';
import type { RouseRequest, StandaloneDirective } from '../types';
import { rzStoreConfig } from './request-config';
import { rzHeaders } from './rz-headers';

const initialized = new WeakSet<HTMLScriptElement>();

/**
 * Bootstraps a global reactive store from a `<script>` tag. Initializes the reactive
 * data registry and seeds the store's URL from `rz-store-config` if present.
 *
 * Push/pull triggers (`rz-push`, `rz-pull`) are wired separately, so the store doesn't
 * need to know about them.
 */
function initialize(el: HTMLScriptElement, app: RouseApp) {
  if (initialized.has(el)) return;

  const storeName = getDirectiveValue(el, 'store')?.trim();
  if (!storeName) {
    __DEV__ && warn(`rz-store: value is missing or empty.`, el);
    return;
  }

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

  const storeConfig = rzStoreConfig.getConfig(el);
  const headers = rzHeaders.getConfig(el);

  // `action` isn't a request key; the config parser stores it as a literal string.
  const { method, action, ...transport } = storeConfig as Partial<RouseRequest> & {
    action?: string;
  };

  const cfg: Partial<SyncPolicy> = { ...transport };

  if (Object.keys(headers).length) {
    cfg.headers = headers;
  }

  const pushMethod = resolveMethod(method, el);
  if (pushMethod) {
    cfg.pushMethod = pushMethod;
  }

  if (action !== undefined) {
    if (isPatchAction(action)) {
      cfg.action = action.toLowerCase() as PatchAction;
    } else {
      __DEV__ && warn(`rz-store-config: unknown action '${action}'. Ignoring.`, el);
    }
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

function teardown(el: HTMLScriptElement) {
  initialized.delete(el);
}

export const rzStore = {
  selector: directiveSelector('store', 'script'),
  initialize,
  teardown,
} as const satisfies StandaloneDirective<HTMLScriptElement>;
