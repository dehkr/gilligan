import type { SyncPolicy } from '../core/store';
import type { ConfigDirective } from '../types';
import { type ConfigValueType, parseKeyedConfig, TRANSPORT_KEYS } from './request-config';

/** Keys `rz-store-config` accepts, and how each value is coerced. */
const KEYS: Record<string, ConfigValueType> = { ...TRANSPORT_KEYS };

/**
 * Sync options for the store on this element, applied to every push and pull.
 * Written as `key: value` pairs.
 *
 * - `data-rz-store-config="url: /api/cart, timeout: 5s"`
 */
function getConfig(el: Element): Partial<SyncPolicy> {
  return parseKeyedConfig(el, 'store-config', KEYS) as Partial<SyncPolicy>;
}

export const rzStoreConfig = { getConfig } as const satisfies ConfigDirective<
  Partial<SyncPolicy>
>;
