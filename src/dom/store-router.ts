import type { RouseApp } from '../core/app';
import { warn } from '../core/diagnostics';
import { isPlainObject } from '../core/state';
import { rzDeposit } from '../directives';
import type { RouseResponse, RoutablePayload } from '../types';

/**
 * Listens to the app root for JSON fetch responses and stream messages, and routes the
 * payloads into global stores named by `rz-target` or a server `Rouse-Target` header.
 * Since programmatic fetch doesn't originate from an element, it doesn't route unless the
 * `triggerEl` option is set explicitly. Error responses route only when the server names
 * a target, since `rz-target` is success-only output.
 */
export function initStoreRouter(app: RouseApp, signal: AbortSignal) {
  const route = (e: Event, operation: 'fetch' | 'sse') => {
    const { detail } = e as CustomEvent<RoutablePayload>;
    const { config, data, targetOverride } = detail;
    const triggerEl = config?.triggerEl;

    // Don't route an error response unless the server provides an override
    if (e.type.includes('error') && !targetOverride) return;

    // No trigger means nothing declared a destination; the caller gets the data
    if (!triggerEl && !targetOverride) return;

    const stores = rzDeposit.getConfig(triggerEl ?? app.root, targetOverride);

    // Only the fetch listeners are registered with a `RouseResponse` detail
    const response = operation === 'fetch' ? (detail as RouseResponse) : undefined;

    routeToStore(app, stores, data, operation, response);
  };

  ['rz:fetch:success:json', 'rz:fetch:error:json'].forEach((name) => {
    app.root.addEventListener(name, (e) => route(e, 'fetch'), { signal });
  });

  app.root.addEventListener('rz:sse:message:json', (e) => route(e, 'sse'), { signal });
}

/**
 * Deposits a JSON `payload` into each named store; a whole-payload deposit, not the
 * per-field reconciliation `rz-pull` performs. Non-POJO payloads and unknown store
 * names warn and are skipped.
 *
 * @param stores - Store names to deposit into (from `rz-target`'s `@store` targets).
 * @param payload - The parsed JSON body to write into each store.
 * @param operation - What produced the payload, surfaced on the rz:store:patch detail.
 * @param response - The response that produced it, absent for a stream message.
 */
function routeToStore(
  app: RouseApp,
  stores: string[],
  payload: any,
  operation: 'fetch' | 'sse',
  response?: RouseResponse,
) {
  if (stores.length === 0) return;

  if (!isPlainObject(payload)) {
    __DEV__ &&
      warn('Cannot route JSON payload to a store. Expected a JSON object.', payload);
    return;
  }

  for (const storeName of stores) {
    if (!app.stores.has(storeName)) {
      __DEV__ && warn(`Cannot route JSON payload to '@${storeName}'. No such store.`);
      continue;
    }

    app.stores.deposit(storeName, payload, { response, operation });
  }
}
