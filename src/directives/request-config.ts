import { getDirectiveValue } from '../core/attributes';
import { warn } from '../core/diagnostics';
import { parseDirectiveValue, safeJSONParse } from '../core/parser';
import { parseTime } from '../core/timing';
import type { ConfigDirective, DirectiveSlug, RouseRequest } from '../types';

/** Keys parsed as booleans. */
const BOOLEAN_KEYS = ['keepalive', 'rollback-on-error', 'skip-interceptors'];
/** Keys that must hold an object, written as inline JSON. */
const OBJECT_KEYS = ['params'];
/** Keys that hold an object when written as inline JSON, and a literal otherwise. */
const ANY_KEYS = ['body'];
/** Keys parsed as durations by `parseTime`. */
const DURATION_KEYS = ['timeout'];

/**
 * Factory for the two request-config directives, `rz-fetch-config` and `rz-store-config`.
 */
function defineRequestConfigDirective(
  slug: DirectiveSlug,
  reject: string[],
): ConfigDirective<Partial<RouseRequest>> {
  return {
    getConfig: (el) => parseRequestConfig(getDirectiveValue(el, slug), el, slug, reject),
  };
}

/**
 * Parses a request-config directive value into a partial `RouseRequest`. One branch
 * per value type: objects, booleans, durations, and literal strings for everything
 * else. Shared by `rz-fetch-config` and `rz-store-config`.
 */
function parseRequestConfig(
  value: string | null | undefined,
  el: Element,
  slug: DirectiveSlug,
  reject: string[],
): Partial<RouseRequest> {
  if (!value) return {};

  const parsed = parseDirectiveValue(value);
  const config: Record<string, any> = {};

  for (const [key, rawVal] of parsed) {
    if (!key) continue;
    const val = rawVal ?? '';

    // Keys this directive doesn't own. `headers` and `indicator` have their own
    // directives; the rest are inapplicable to the operation.
    if (reject.includes(key)) {
      __DEV__ &&
        warn(
          key === 'headers' || key === 'indicator'
            ? `rz-${slug}: '${key}' belongs on rz-${key}. Ignoring.`
            : `rz-${slug}: '${key}' is not configurable here. Ignoring.`,
          el,
        );
    }

    // Objects, written as inline JSON
    else if (OBJECT_KEYS.includes(key)) {
      const obj = parseObject(val, key, el, slug);
      if (obj !== undefined) {
        config[kebabToCamel(key)] = obj;
      }
    }

    // Inline JSON when it looks like an object, otherwise a literal
    else if (ANY_KEYS.includes(key)) {
      if (!isObjectLiteral(val)) {
        config[kebabToCamel(key)] = val;
      } else {
        const obj = parseObject(val, key, el, slug);
        if (obj !== undefined) {
          config[kebabToCamel(key)] = obj;
        }
      }
    }

    // Booleans
    else if (BOOLEAN_KEYS.includes(key)) {
      config[kebabToCamel(key)] = val === 'true' || val === '';
    }

    // Durations
    else if (DURATION_KEYS.includes(key)) {
      config[kebabToCamel(key)] = parseTime(val);
    }

    // Everything else is a literal string: url, method, abort-key, credentials
    else {
      config[kebabToCamel(key)] = val;
    }
  }

  return config as Partial<RouseRequest>;
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

export const rzFetchConfig = defineRequestConfigDirective('fetch-config', [
  'headers',
  'indicator',
]);
export const rzStoreConfig = defineRequestConfigDirective('store-config', [
  'headers',
  'indicator',
  'body',
  'form',
]);
