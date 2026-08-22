import type { RouseApp } from '../core/app';
import { getDirectiveValue } from '../core/attributes';
import { warn } from '../core/diagnostics';
import { resolveInjection } from '../core/injection';
import { parseDirectiveValue } from '../core/parser';
import { parseTime } from '../core/timing';
import type { ConfigDirective, DirectiveSlug, RouseRequest } from '../types';

/** Keys parsed as booleans. */
const BOOLEAN_KEYS = ['keepalive', 'rollback-on-error', 'skip-interceptors'];
/** Keys that can hold an object, written as an injection reference or inline JSON. */
const OBJECT_KEYS = ['params', 'body'];
/** Keys parsed as durations by `parseTime`. */
const DURATION_KEYS = ['timeout'];

/**
 * Factory for the two request-config directives, `rz-fetch-config` and `rz-store-config`.
 */
function defineRequestConfigDirective(
  slug: DirectiveSlug,
): ConfigDirective<Partial<RouseRequest>> {
  return {
    getConfig: (el, app) =>
      parseRequestConfig(getDirectiveValue(el, slug), app, el, slug),
  };
}

/**
 * Parses a request-config directive value into a partial `RouseRequest`. One branch
 * per value type: objects, booleans, durations, and literal strings for everything
 * else. Shared by `rz-fetch-config` and `rz-store-config`.
 */
function parseRequestConfig(
  value: string | null | undefined,
  app: RouseApp,
  el: Element,
  slug: DirectiveSlug,
): Partial<RouseRequest> {
  if (!value) return {};

  const parsed = parseDirectiveValue(value);
  const config: Record<string, any> = {};

  for (const [key, rawVal] of parsed) {
    if (!key) continue;
    const val = rawVal ?? '';

    // Reject rather than ignore to enforce single channel via rz-headers
    if (key === 'headers') {
      __DEV__ && warn(`rz-${slug}: headers belong on rz-headers. Ignoring.`, el);
    }

    // Objects, written as an injection reference or inline JSON
    else if (OBJECT_KEYS.includes(key)) {
      config[kebabToCamel(key)] = /^[#@{]/.test(val)
        ? resolveInjection(val, app.stores, false)
        : val;
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

function kebabToCamel(str: string) {
  return str.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

export const rzFetchConfig = defineRequestConfigDirective('fetch-config');
export const rzStoreConfig = defineRequestConfigDirective('store-config');
