import type { AnyFn, BindableValue, DirectiveSlug, HandlerCtx, Scope } from '../types';
import { KEY_BLOCKLIST, STORE_PREFIX } from './constants';
import { err, warn } from './diagnostics';
import { parseDataSourcePath, parseStoreRef } from './parser';
import { getNestedVal } from './path';
import { renderCtxOf } from './render-context';
import { resolveState } from './resolve';
import { isPlainObject } from './state';
import type { StoreManager } from './store';

/**
 * Parse JSON with recursive check that blocks prototype pollution keys.
 */
function safeJSONParse(text: string): unknown {
  return JSON.parse(text, (key, value) => {
    if (KEY_BLOCKLIST.includes(key)) {
      __DEV__ && warn(`Blocked forbidden key in JSON: '${key}'.`);
      return undefined;
    }
    return value;
  });
}

/**
 * Resolves a payload string into a JavaScript value. Uses heuristics to determine
 * if the payload is inline JSON, a DOM ID, or a global store.
 *
 * @param requireObject - If true (default), enforces that the resolved value is an object.
 */
export function resolveInjection(
  input: string | undefined | null,
  storeManager: StoreManager,
  requireObject = true,
): Record<string, any> | undefined {
  const value = input?.trim();
  if (!value) return undefined;

  let resolvedValue: any;

  // Store data
  if (value.startsWith(STORE_PREFIX)) {
    const ref = parseStoreRef(value);
    if (!ref) return undefined;

    const storeData = storeManager.get(ref.source);
    if (storeData === undefined) {
      __DEV__ && warn(`Store '@${ref.source}' not found. Cannot resolve '${value}'.`);
      return undefined;
    }
    resolvedValue = ref.nestedPath ? getNestedVal(storeData, ref.nestedPath) : storeData;
  }

  // DOM script ID
  else if (value.startsWith('#')) {
    const { source: id, nestedPath } = parseDataSourcePath(value);
    const el = document.getElementById(id);
    if (el && el instanceof HTMLScriptElement && el.type === 'application/json') {
      const content = el.textContent?.trim();
      if (content) {
        try {
          const parsed = safeJSONParse(content);
          resolvedValue = nestedPath ? getNestedVal(parsed, nestedPath) : parsed;
        } catch (error) {
          __DEV__ && warn(`Invalid JSON in #${id}.`, error);
        }
      }
    } else {
      __DEV__ &&
        warn(
          el
            ? `#${id} is not a script tag of type 'application/json'.`
            : `#${id} not found.`,
        );
    }
  }

  // Inline JSON object
  else if (value.startsWith('{')) {
    try {
      resolvedValue = safeJSONParse(value);
    } catch (error) {
      __DEV__ && warn(`Invalid inline JSON.`, error);
    }
  }

  // Final check
  if (resolvedValue !== undefined) {
    if (!requireObject || isPlainObject(resolvedValue)) {
      return resolvedValue;
    }
    __DEV__ && warn(`Invalid payload: '${value}'. Data must resolve to an object.`);
  }

  return undefined;
}

/**
 * Splits an injection string into its key and raw payload components.
 * Supports `{`, `@`, and `#` as payload delimiters.
 */
export function splitInjection(raw: string): {
  key: string;
  rawPayload: string | undefined;
} {
  // Find the first index of a payload delimiter starting after the first character.
  // This accommodates store keys like `@my-store.handler{ "id": 234 }`.
  const matchIndex = raw.substring(1).search(/[#@{]/);

  if (matchIndex === -1) {
    return { key: raw.trim(), rawPayload: undefined };
  }

  const i = matchIndex + 1;
  return {
    key: raw.slice(0, i).trim(),
    rawPayload: raw.slice(i).trim(),
  };
}

/**
 * Invokes a resolved handler with a `HandlerCtx` built from the raw payload,
 * the triggering event, and the binding scope's render context. Returns the
 * handler's result, or `undefined` if it throws.
 */
export function invokeHandler(
  method: AnyFn,
  context: unknown,
  name: string,
  rawPayload: string | undefined,
  scope: Scope,
  storeManager: StoreManager,
  el: Element,
  e: Event,
): unknown {
  try {
    const params =
      rawPayload !== undefined ? (resolveInjection(rawPayload, storeManager) ?? {}) : {};
    const args: HandlerCtx<Record<string, any>, Element> = {
      params,
      e,
      el,
      render: renderCtxOf(scope),
    };
    return method.call(context, args);
  } catch (error) {
    __DEV__ && err(`Failed to execute '${name}()'.`, el, error);
    return undefined;
  }
}

/**
 * Resolves a one-way binding value that may target a static property or a
 * function. If the target is a function, it is invoked with a `HandlerCtx` whose
 * `e` is a synthetic CustomEvent typed `rz:${slug}`. If a payload was provided
 * but the target is not callable, logs a warning and returns the static state.
 *
 * Returns `undefined` when the key resolves to nothing. An absent path is a
 * valid empty state, not an error, so callers render it as empty rather than
 * preserving stale content.
 */
export function resolveBoundValue(
  raw: string,
  scope: Scope,
  storeManager: StoreManager,
  el: Element,
  slug: DirectiveSlug,
): BindableValue {
  const { key, rawPayload } = splitInjection(raw);

  const state = resolveState<unknown>(key, scope, storeManager);

  if (typeof state === 'function') {
    const context = key.startsWith(STORE_PREFIX)
      ? storeManager.get(parseDataSourcePath(key).source)
      : scope;

    return invokeHandler(
      state as AnyFn,
      context,
      key,
      rawPayload,
      scope,
      storeManager,
      el,
      new CustomEvent(`rz:${slug}`),
    ) as BindableValue;
  }

  __DEV__ &&
    rawPayload !== undefined &&
    warn(`'${key}' is not callable; ignoring payload '${rawPayload}'.`);

  return state as BindableValue;
}
