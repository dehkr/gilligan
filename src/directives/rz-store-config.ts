import { type HttpMethod, isHttpMethod } from '../core/constants';
import { warn } from '../core/diagnostics';
import type { SyncPolicy } from '../core/store';
import type { ConfigDirective } from '../types';
import { type ConfigValueType, parseKeyedConfig, TRANSPORT_KEYS } from './request-config';

/** Keys `rz-store-config` accepts, and how each value is coerced. */
const KEYS: Record<string, ConfigValueType> = {
  ...TRANSPORT_KEYS,
  'push-method': 'string',
};

/**
 * Sync options for the store on this element, applied to every push and pull.
 * Written as `key: value` pairs.
 *
 * - `data-rz-store-config="url: /api/cart, push-method: put"`
 */
function getConfig(el: Element): Partial<SyncPolicy> {
  const { pushMethod, ...transport } = parseKeyedConfig(el, 'store-config', KEYS);
  const cfg: Partial<SyncPolicy> = transport;

  if (pushMethod !== undefined) {
    if (isHttpMethod(pushMethod)) {
      cfg.pushMethod = pushMethod.toUpperCase() as HttpMethod;
    } else {
      __DEV__ &&
        warn(`rz-store-config: unknown HTTP method '${pushMethod}'. Ignoring.`, el);
    }
  }

  return cfg;
}

export const rzStoreConfig = { getConfig } as const satisfies ConfigDirective<
  Partial<SyncPolicy>
>;
