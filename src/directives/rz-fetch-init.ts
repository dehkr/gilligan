import { getDirectiveValue } from '../core/attributes';
import { warn } from '../core/diagnostics';
import { parseDirectiveValue, safeJSONParse } from '../core/parser';
import { parseTime } from '../core/timing';
import type { ConfigDirective, FetchRequest } from '../types';

/** How a config value is coerced. `any` takes inline JSON or a literal. */
type ConfigValueType = 'string' | 'boolean' | 'duration' | 'object' | 'any';

/**
 * Keys `rz-fetch-init` accepts, and how each value is coerced. A key outside this
 * table warns and is dropped, so a typo or a key belonging to another directive
 * can't sit in a config doing nothing.
 */
const KEYS = {
  method: 'string',
  body: 'any',
  params: 'object',
  timeout: 'duration',
  'abort-key': 'string',
  credentials: 'string',
  keepalive: 'boolean',
  redirect: 'string',
  cache: 'string',
} as const satisfies Record<string, ConfigValueType>;

/**
 * Request options for the element's `rz-fetch`, written as `key: value` pairs.
 * `params` takes an inline JSON object; `body` can also take an inline JSON object
 * or a literal string.
 *
 * @example
 * <button data-rz-fetch="click: /save" data-rz-fetch-init="method: post, timeout: 5s">
 */
function getConfig(el: Element): Partial<FetchRequest> {
  const value = getDirectiveValue(el, 'fetch-init');
  if (!value) return {};

  const config: Record<string, any> = {};

  for (const [key, rawVal] of parseDirectiveValue(value)) {
    if (!key) continue;

    const type = KEYS[key as keyof typeof KEYS];

    if (!type) {
      __DEV__ &&
        warn(
          key === 'headers' || key === 'indicator'
            ? `rz-fetch-init: '${key}' belongs on data-rz-${key}. Ignoring.`
            : `rz-fetch-init: unknown key '${key}'. Ignoring.`,
          el,
        );
      continue;
    }

    const val = rawVal ?? '';

    if (type === 'boolean') {
      config[kebabToCamel(key)] = val === 'true' || val === '';
    } else if (type === 'duration') {
      config[kebabToCamel(key)] = parseTime(val);
    } else if (type === 'object' || (type === 'any' && isObjectLiteral(val))) {
      const obj = parseObject(val, key, el);
      if (obj !== undefined) {
        config[kebabToCamel(key)] = obj;
      }
    } else {
      config[kebabToCamel(key)] = val;
    }
  }

  return config as Partial<FetchRequest>;
}

function isObjectLiteral(val: string) {
  return val.startsWith('{');
}

/**
 * Parses an inline JSON object. Returns undefined when the value isn't one, so the
 * caller can leave the key unset rather than write a malformed config value.
 */
function parseObject(val: string, key: string, el: Element) {
  if (isObjectLiteral(val)) {
    try {
      return safeJSONParse(val);
    } catch {
      __DEV__ && warn(`rz-fetch-init: '${key}' is not valid JSON: ${val}`, el);
      return undefined;
    }
  }

  __DEV__ &&
    warn(`rz-fetch-init: '${key}' must be an inline JSON object. Got: ${val}`, el);
  return undefined;
}

function kebabToCamel(str: string) {
  return str.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

export const rzFetchInit = { getConfig } as const satisfies ConfigDirective<
  Partial<FetchRequest>
>;
