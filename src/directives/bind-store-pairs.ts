import type { RouseApp } from '../core/app';
import { hasDirective } from '../core/attributes';
import { STORE_PREFIX } from '../core/constants';
import { warn } from '../core/diagnostics';
import { getPathRoot } from '../core/path';
import { resolveTarget } from '../core/store';
import { dispatchTrigger } from '../dom/events';
import type { TriggerSubjectPair, VoidFn } from '../types';

/**
 * Binds each `[trigger]: @store[.path]` pair to a push or pull. The push `edit`
 * trigger fires on store mutation via the `edit` trigger source; every other
 * trigger routes through `dispatchTrigger`. Returns the cleanups.
 */
export function bindStorePairs(
  op: 'push' | 'pull',
  el: Element,
  app: RouseApp,
  pairs: TriggerSubjectPair[],
) {
  const cleanups: VoidFn[] = [];

  // Sync config lives on the store, so these are inert here and otherwise silent
  if (__DEV__ && !hasDirective(el, 'fetch') && !hasDirective(el, 'store')) {
    hasDirective(el, 'headers') &&
      warn(
        `rz-${op}: data-rz-headers on a trigger element is ignored. Set headers on the store's <script data-rz-store> element.`,
        el,
      );
    hasDirective(el, 'resource') &&
      warn(
        `rz-${op}: data-rz-resource on a trigger element is ignored. Set the endpoint on the store's <script data-rz-store> element.`,
        el,
      );
  }

  for (const { trigger, subject } of pairs) {
    const resolved = resolveTarget(el, op, subject);
    if (!resolved) continue;

    const { storeName, nestedPath } = resolved;
    const isEdit = trigger.event === 'edit';
    const rootKey = getPathRoot(nestedPath);

    // The trigger resolves its own store, so hand it the one the subject named
    const def =
      isEdit && !trigger.options.arg
        ? {
            ...trigger,
            options: {
              ...trigger.options,
              arg: `${STORE_PREFIX}${storeName}${nestedPath ? `.${nestedPath}` : ''}`,
            },
          }
        : trigger;

    const sync = () => triggerStoreSync(op, el, app, storeName, nestedPath);

    // A debounced edit can settle after the value was pushed, reset, or retyped
    // back to the baseline, so the check runs when the timer fires, not when armed.
    const fire = isEdit
      ? () => {
          if (app.stores.isDirty(storeName, rootKey)) {
            sync();
          }
        }
      : sync;

    const cleanup = dispatchTrigger(def, { el, app, action: fire });
    if (cleanup) {
      cleanups.push(cleanup);
    }
  }

  return cleanups;
}

/**
 * Dispatches a push or pull through the store manager. Bails when the trigger is
 * gone or disabled, when the target store isn't registered, or when the store
 * already has a request in flight. Request config comes from the store, not here.
 */
function triggerStoreSync(
  op: 'push' | 'pull',
  triggerEl: Element,
  app: RouseApp,
  storeName: string,
  nestedPath?: string,
) {
  // A debounced or queued trigger can fire after the element is gone
  if (!triggerEl.isConnected) return;

  if (
    triggerEl.hasAttribute('disabled') ||
    triggerEl.getAttribute('aria-disabled') === 'true'
  ) {
    return;
  }

  const status = app.stores.status(storeName);
  if (!status) {
    __DEV__ && warn(`rz-${op}: store '@${storeName}' not found.`, triggerEl);
    return;
  }
  if (status.loading) return;

  app.stores[op](storeName, { nestedPath, triggerEl });
}
