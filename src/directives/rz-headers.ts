import type { RouseApp } from '../core/app';
import { getDirectiveValue } from '../core/attributes';
import { warn } from '../core/diagnostics';
import { resolveInjection } from '../core/injection';
import { parseDirectiveValue } from '../core/parser';
import type { ConfigDirective } from '../types';

/**
 * Request headers for an element. Read by the network directives. Supports object
 * injection (`#`, `@`, `{`) or static key-value pairs. A `null` value removes the
 * header from the request; an empty string is sent as is.
 *
 * - `rz-headers="Tenant: 123"`
 * - `rz-headers="Rouse-Request: null"` (remove framework default)
 * - `rz-headers="X-Blank: ''"` (send with an empty value)
 * - `rz-headers="@session.authHeaders"`
 * - `rz-headers="#auth-headers"`
 * - `rz-headers='{ "Tenant": 123 }'`
 */
function getConfig(el: Element, app: RouseApp): Record<string, string | null> {
  return parseHeadersConfig(getDirectiveValue(el, 'headers'), el, app);
}

/**
 * Parses a header record from an injected object or static key-value pairs.
 */
function parseHeadersConfig(
  value: string | null | undefined,
  el: Element,
  app: RouseApp,
): Record<string, string | null> {
  if (!value) return {};

  // Object injection
  if (value.match(/^[#@{]/)) {
    const resolvedObject = resolveInjection(value, app.stores, false);
    const headers: Record<string, string | null> = {};

    if (resolvedObject && typeof resolvedObject === 'object') {
      for (const [k, v] of Object.entries(resolvedObject)) {
        headers[k] = v == null ? null : String(v);
      }
    } else {
      __DEV__ &&
        warn(`rz-headers: payload '${value}' does not resolve to an object.`, el);
    }
    return headers;
  }

  // Static key-value pairs
  const headers: Record<string, string | null> = {};
  for (const [key, val] of parseDirectiveValue(value)) {
    if (!key) continue;
    if (val === null) {
      __DEV__ &&
        warn(
          `rz-headers: header '${key}' has no value. Write '${key}: <value>', or '${key}: null' to remove it.`,
          el,
        );
      continue;
    }
    // Treat 'null' as the deletion sentinel, mirroring programmatic null.
    headers[key] = val === 'null' ? null : val;
  }

  return headers;
}

export const rzHeaders = { getConfig } as const satisfies ConfigDirective<
  Record<string, string | null>
>;
