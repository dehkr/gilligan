import type { RouseApp } from '../core/app';
import { directiveSelector } from '../core/attributes';
import { STORE_PREFIX } from '../core/constants';
import { warn } from '../core/diagnostics';
import { invokeHandler, splitInjection } from '../core/injection';
import { parseStoreRef, parseTriggers } from '../core/parser';
import { getNestedVal } from '../core/path';
import { dispatchTrigger } from '../dom/events';
import type { AnyFn, BoundCleanupFn, BoundDirective, Scope, VoidFn } from '../types';

function bind(
  el: Element,
  scope: Scope,
  app: RouseApp,
  key: string,
  value: string,
): BoundCleanupFn | undefined {
  if (!value) {
    __DEV__ &&
      warn(
        `rz-on: value '${key}' is incomplete; at least one trigger and a handler are required.`,
        el,
      );
    return undefined;
  }

  const { key: methodName, rawPayload } = splitInjection(value);

  let method: unknown;
  let context: unknown;

  // Global store (e.g., `@theme.toggleMode`)
  if (methodName.startsWith(STORE_PREFIX)) {
    const ref = parseStoreRef(methodName, 'on');
    if (!ref) return;

    const { source: storeName, nestedPath } = ref;
    const storeData = app.stores.get(storeName);

    if (storeData === undefined) {
      __DEV__ && warn(`rz-on: store '@${storeName}' not found.`, el);
      return;
    }

    if (!nestedPath) {
      __DEV__ &&
        warn(`rz-on: '@${storeName}' needs a handler (e.g., @${storeName}.save).`, el);
      return;
    }

    method = getNestedVal(storeData, nestedPath);
    context = storeData;
  }

  // Local scope method
  else {
    method = scope[methodName];
    context = scope;
  }

  // Validate that the resolved target is actually a function
  if (typeof method !== 'function') {
    __DEV__ && warn(`rz-on: handler '${methodName}' is undefined or not a function.`, el);
    return;
  }

  const triggers = parseTriggers(key);
  const cleanups: VoidFn[] = [];

  for (const trigger of triggers) {
    const cleanup = dispatchTrigger(trigger, {
      el,
      app,
      action: (e?: Event) =>
        invokeHandler(
          method as AnyFn,
          context,
          methodName,
          rawPayload,
          scope,
          app.stores,
          el,
          e ?? new CustomEvent(trigger.event),
        ),
    });
    if (cleanup) {
      cleanups.push(cleanup);
    }
  }

  return (() => cleanups.forEach((fn) => fn())) as BoundCleanupFn;
}

export const rzOn = {
  slug: 'on',
  selector: directiveSelector('on'),
  bind,
} as const satisfies BoundDirective;
