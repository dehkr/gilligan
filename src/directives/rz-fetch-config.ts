import type { ConfigDirective, FetchRequest } from '../types';
import { type ConfigValueType, parseKeyedConfig, TRANSPORT_KEYS } from './request-config';

/** Keys `rz-fetch-config` accepts, and how each value is coerced. */
const KEYS: Record<string, ConfigValueType> = {
  ...TRANSPORT_KEYS,
  method: 'string',
  body: 'any',
};

/**
 * Request options for the element's `rz-fetch`. Written as `key: value` pairs.
 * `params` takes an inline JSON object; `body` can also take an inline JSON object
 * or a literal string.
 *
 * - `rz-fetch-config="method: post, timeout: 5s"`
 * - `rz-fetch-config='params: { "page": 2 }'`
 */
function getConfig(el: Element): Partial<FetchRequest> {
  return parseKeyedConfig(el, 'fetch-config', KEYS) as Partial<FetchRequest>;
}

export const rzFetchConfig = { getConfig } as const satisfies ConfigDirective<
  Partial<FetchRequest>
>;
