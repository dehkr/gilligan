import { getDirectiveValue } from '../core/attributes';
import { warn } from '../core/diagnostics';
import { parseDirectiveValue, safeJSONParse } from '../core/parser';
import { parseTime } from '../core/timing';
import type { DirectiveSlug } from '../types';

/** How a config value is coerced. `any` takes inline JSON or a literal. */
export type ConfigValueType = 'string' | 'boolean' | 'duration' | 'object' | 'any';

/** Keys accepted by every request-config directive. */
export const TRANSPORT_KEYS = {
  url: 'string',
  params: 'object',
  timeout: 'duration',
  'abort-key': 'string',
  'skip-interceptors': 'boolean',
  credentials: 'string',
  keepalive: 'boolean',
  redirect: 'string',
  cache: 'string',
} as const satisfies Record<string, ConfigValueType>;

/**
 * Parses a request-config directive value against the directive's key table.
 * A key outside the table is rejected rather than stored, so a typo or a key
 * belonging to another directive can't sit in a config doing nothing.
 */
export function parseKeyedConfig(
  el: Element,
  slug: DirectiveSlug,
  keys: Record<string, ConfigValueType>,
): Record<string, any> {
  const value = getDirectiveValue(el, slug);
  if (!value) return {};

  const config: Record<string, any> = {};

  for (const [key, rawVal] of parseDirectiveValue(value)) {
    if (!key) continue;

    const type = keys[key];

    if (!type) {
      __DEV__ &&
        warn(
          key === 'headers' || key === 'indicator'
            ? `rz-${slug}: '${key}' belongs on data-rz-${key}. Ignoring.`
            : `rz-${slug}: unknown key '${key}'. Ignoring.`,
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
      const obj = parseObject(val, key, el, slug);
      if (obj !== undefined) {
        config[kebabToCamel(key)] = obj;
      }
    } else {
      config[kebabToCamel(key)] = val;
    }
  }

  return config;
}

function isObjectLiteral(val: string) {
  return val.startsWith('{');
}

/**
 * Parses an inline JSON object. Returns undefined when the value isn't one, so the
 * caller can leave the key unset rather than write a malformed config value.
 */
function parseObject(val: string, key: string, el: Element, slug: DirectiveSlug) {
  if (isObjectLiteral(val)) {
    try {
      return safeJSONParse(val);
    } catch {
      __DEV__ && warn(`rz-${slug}: '${key}' is not valid JSON: ${val}`, el);
      return undefined;
    }
  }

  __DEV__ && warn(`rz-${slug}: '${key}' must be an inline JSON object. Got: ${val}`, el);
  return undefined;
}

function kebabToCamel(str: string) {
  return str.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}
