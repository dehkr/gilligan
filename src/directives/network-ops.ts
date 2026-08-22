import type { RouseApp } from '../core/app';
import { directiveSelector, getDirectiveValue } from '../core/attributes';
import type { PatchAction } from '../core/constants';
import { warn } from '../core/diagnostics';
import {
  parseFetchSubject,
  parseStoreSubject,
  parseTriggerSubjectPairs,
} from '../core/parser';
import { getPathRoot } from '../core/path';
import { resolveTarget } from '../core/store';
import { applyTiming } from '../core/timing';
import { dispatchTrigger, isNativeNavigation } from '../dom/events';
import { runFetch } from '../net/fetch-engine';
import { resolveRequestConfig } from '../net/request';
import type {
  DirectiveSlug,
  RouseRequest,
  StandaloneDirective,
  TriggerDef,
  TriggerSubjectPair,
  VoidFn,
} from '../types';
import { rzFetchConfig } from './request-config';

const EXAMPLES = {
  fetch: 'click: /users',
  push: 'click: @users',
  pull: 'page-visible: @users',
} as const;

/**
 * Factory for the network directives (rz-fetch, rz-push, rz-pull), which share
 * the `[trigger]: [subject]` grammar. Owns the per-element cleanup registry and
 * the shared initialize/teardown scaffolding.
 *
 * @param bindPairs - Wires the parsed pairs for one element and returns their cleanups.
 */
function defineNetworkOpDirective(
  slug: Extract<DirectiveSlug, 'fetch' | 'push' | 'pull'>,
  bindPairs: (el: Element, app: RouseApp, pairs: TriggerSubjectPair[]) => VoidFn[],
): StandaloneDirective {
  const elementCleanups = new WeakMap<Element, VoidFn[]>();

  return {
    selector: directiveSelector(slug),
    initialize(el: Element, app: RouseApp) {
      if (elementCleanups.has(el)) return;

      const value = getDirectiveValue(el, slug);
      if (value === null) return;

      const pairs = parseTriggerSubjectPairs(value);
      if (pairs.length === 0) {
        __DEV__ &&
          warn(
            `rz-${slug}: at least one trigger is required (e.g., rz-${slug}="${EXAMPLES[slug]}").`,
            el,
          );
        return;
      }

      const cleanups = bindPairs(el, app, pairs);
      if (cleanups.length > 0) {
        elementCleanups.set(el, cleanups);
      }
    },
    teardown(el: Element) {
      elementCleanups.get(el)?.forEach((fn) => fn());
      elementCleanups.delete(el);
    },
  };
}

/**
 * Returns the URL value if it exists from an anchor element's `href` or
 * a form element's `action` attribute.
 */
function nativeUrl(el: Element): string {
  if (el instanceof HTMLAnchorElement) {
    return el.getAttribute('href') ?? '';
  }
  if (el instanceof HTMLFormElement) {
    return el.getAttribute('action') ?? '';
  }
  return '';
}

/**
 * Extracts `formaction` and `formmethod` from the button that triggered a
 * submit event to override the form's default request configuration.
 */
function applySubmitterOverrides(baseOpts: RouseRequest, e?: Event): RouseRequest {
  const opts: RouseRequest = { ...baseOpts };
  const sub = e instanceof SubmitEvent ? e.submitter : null;

  if (sub) {
    opts.url = sub.getAttribute('formaction') ?? opts.url;
    opts.method = sub.getAttribute('formmethod')?.toUpperCase() ?? opts.method;
  }

  return opts;
}

/**
 * Binds each `[trigger]: [[METHOD] URL]` pair to a fetch. Resolves the URL once
 * and shares it across the element's triggers. Returns the pairs' cleanups.
 */
function bindFetchPairs(el: Element, app: RouseApp, pairs: TriggerSubjectPair[]) {
  const cleanups: VoidFn[] = [];
  const elementUrl = rzFetchConfig.getConfig(el, app).url || nativeUrl(el);

  // A form without a URL at init can still get one at submit time from the
  // submitter's `formaction`, so bind anyway and validate on dispatch.
  const deferUrl = el instanceof HTMLFormElement;

  // The URL is shared by every trigger, so resolve and validate it once
  let warnedMissingUrl = false;

  for (const { trigger, subject } of pairs) {
    const parsed = subject ? parseFetchSubject(subject) : {};

    // URL value from `rz-fetch` takes precedence
    const url = parsed.url || elementUrl;

    // If the URL is missing, it could mean there isn't one configured,
    // or that it's in the wrong position (missing trigger).
    if (!url && !deferUrl) {
      if (__DEV__ && !warnedMissingUrl) {
        warn(
          `rz-fetch: no URL found. Configure it using rz-fetch (with at least one leading trigger), rz-fetch-config, or a native 'href', 'action', or 'formaction' attribute.`,
          el,
        );
        warnedMissingUrl = true;
      }
      continue;
    }

    const cleanup = dispatchTrigger(trigger, {
      el,
      app,
      action: (e?: Event) => {
        if (e && isNativeNavigation(el, e)) {
          e.preventDefault();
        }
        const opts = applySubmitterOverrides({ ...parsed, url, triggerEl: el }, e);
        if (!opts.url) {
          __DEV__ &&
            warn(
              `rz-fetch: no URL found. Configure it using rz-fetch (with at least one leading trigger), rz-fetch-config, or a native 'href', 'action', or 'formaction' attribute.`,
              el,
            );
          return;
        }
        runFetch(app, opts);
      },
    });

    if (cleanup) {
      cleanups.push(cleanup);
    }
  }

  return cleanups;
}

/**
 * Binds each `[trigger]: [[action] @store[.path]]` pair to a push or pull.
 * The push `edit` trigger fires on store mutation via `bindStoreEditTrigger`;
 * every other trigger routes through `dispatchTrigger`. Returns the cleanups.
 */
function bindStorePairs(
  op: 'push' | 'pull',
  el: Element,
  app: RouseApp,
  pairs: TriggerSubjectPair[],
) {
  const cleanups: VoidFn[] = [];

  for (const { trigger, subject } of pairs) {
    const parsed = subject ? parseStoreSubject(subject, el) : {};
    if (!parsed) continue;

    const { action, target } = parsed;
    const resolved = resolveTarget(el, op, target ?? null);
    if (!resolved) continue;

    const { storeName, nestedPath } = resolved;
    const fire = () => triggerStoreSync(op, el, app, storeName, nestedPath, action);

    if (op === 'push' && trigger.event === 'edit') {
      cleanups.push(
        bindStoreEditTrigger(app, storeName, trigger.options, fire, nestedPath),
      );
      continue;
    }

    const cleanup = dispatchTrigger(trigger, { el, app, action: fire });
    if (cleanup) cleanups.push(cleanup);
  }

  return cleanups;
}

/**
 * Resolves the merged request config from the trigger and target elements and
 * dispatches a push or pull through the store manager. Bails when the target
 * store isn't registered or already has a request in flight.
 */
function triggerStoreSync(
  op: 'push' | 'pull',
  triggerEl: Element,
  app: RouseApp,
  storeName: string,
  nestedPath?: string,
  action?: PatchAction,
) {
  const status = app.stores.status(storeName);
  if (!status) {
    __DEV__ && warn(`rz-${op}: store '@${storeName}' not found.`, triggerEl);
    return;
  }
  if (status.loading) return;

  const targetEl = app.stores.elementFor(storeName);
  const overrides = resolveRequestConfig(triggerEl, op, app, targetEl);

  app.stores[op](storeName, { overrides, nestedPath, action, triggerEl });
}

/**
 * Fires a push when the target store is edited (the `edit` trigger).
 */
function bindStoreEditTrigger(
  app: RouseApp,
  storeName: string,
  options: TriggerDef['options'],
  fire: VoidFn,
  nestedPath: string,
): VoidFn {
  const rootKey = nestedPath ? getPathRoot(nestedPath) : null;

  const guardedFire = () => {
    const status = app.stores.status(storeName);
    if (!status) return;
    const hasDirty = rootKey
      ? !!status.dirty[rootKey]
      : Object.keys(status.dirty).length > 0;
    if (!hasDirty) return;
    fire();
  };

  const debouncedFire = applyTiming(guardedFire, options);
  const stopListener = app.stores.onEdit(storeName, debouncedFire);

  return () => {
    debouncedFire.cancel();
    stopListener();
  };
}

export const rzFetch = defineNetworkOpDirective('fetch', bindFetchPairs);

export const rzPush = defineNetworkOpDirective('push', (el, app, pairs) =>
  bindStorePairs('push', el, app, pairs),
);

export const rzPull = defineNetworkOpDirective('pull', (el, app, pairs) =>
  bindStorePairs('pull', el, app, pairs),
);

export const NETWORK_DIRECTIVES = [rzFetch, rzPush, rzPull];
