import type { RouseApp } from '../core/app';
import { getDirectiveValue } from '../core/attributes';
import { resolveInjection } from '../core/injection';
import { parseDirectiveValue } from '../core/parser';
import { parseTime } from '../core/timing';
import type { ConfigDirective, DirectiveSlug, RouseRequest } from '../types';

const BOOLEAN_KEYS = ['keepalive', 'rollback-on-error', 'skip-interceptors', 'swap'];

/**
 * Factory for `rz-request` and its variants.
 */
function defineRequestConfigDirective(
  slug: DirectiveSlug,
): ConfigDirective<Partial<RouseRequest>> {
  return {
    slug,
    getConfig: (el, app) => parseRequestConfig(getDirectiveValue(el, slug), app),
  };
}

/**
 * Parses a `rz-request*` directive value into a partial RouseRequest config.
 * Shared by `rz-request` and its action-specific variants.
 */
function parseRequestConfig(
  value: string | null | undefined,
  app: RouseApp,
): Partial<RouseRequest> {
  if (!value) return {};

  const parsed = parseDirectiveValue(value);
  const config: Record<string, any> = {};

  for (const [key, rawVal] of parsed) {
    if (!key) continue;
    const val = rawVal ?? '';

    // Dynamic payload delimiters
    if (val.match(/^[#@{]/)) {
      config[key] = resolveInjection(val, app.stores, false);
    }

    // Booleans
    else if (BOOLEAN_KEYS.includes(key)) {
      config[kebabToCamel(key)] = val === 'true' || val === '';
    }

    // timeout
    else if (key === 'timeout') {
      config[kebabToCamel(key)] = parseTime(val);
    }

    // RequestInit options and 'abort-key'
    else {
      config[kebabToCamel(key)] = val;
    }
  }

  return config as Partial<RouseRequest>;
}

function kebabToCamel(str: string) {
  return str.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

export const rzRequest = defineRequestConfigDirective('request');
export const rzPushRequest = defineRequestConfigDirective('push-request');
export const rzFetchRequest = defineRequestConfigDirective('fetch-request');
export const rzPullRequest = defineRequestConfigDirective('pull-request');
