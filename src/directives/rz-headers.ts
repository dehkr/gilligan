import { getDirectiveValue } from '../core/attributes';
import { warn } from '../core/diagnostics';
import { parseDirectiveValue, safeJSONParse } from '../core/parser';
import type { ConfigDirective } from '../types';

/**
 * Request headers for an element. Read by the network directives. Written as key-value
 * pairs, or as an inline JSON object. A `null` value removes the header from the
 * request; an empty string is sent as is. Values that contain a comma should be
 * wrapped in quotes.
 *
 * - `data-rz-headers="Tenant: 123"`
 * - `data-rz-headers="Rouse-Request: null"`
 * - `data-rz-headers="X-Blank: ''"`
 * - `data-rz-headers="Accept: 'text/html, application/json'"`
 * - `data-rz-headers='{ "Tenant": 123 }'`
 */
function getConfig(el: Element): Record<string, string | null> {
  return parseHeadersConfig(getDirectiveValue(el, 'headers'), el);
}

/**
 * Parses a header record from an inline JSON object or static key-value pairs.
 */
function parseHeadersConfig(
  value: string | null | undefined,
  el: Element,
): Record<string, string | null> {
  if (!value) return {};

  const headers: Record<string, string | null> = {};

  // Inline JSON
  if (value.startsWith('{')) {
    try {
      for (const [k, v] of Object.entries(safeJSONParse(value) as object)) {
        headers[k] = v == null ? null : String(v);
      }
    } catch {
      __DEV__ && warn(`rz-headers: value is not valid JSON: ${value}`, el);
    }
    return headers;
  }

  // Static key-value pairs
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
