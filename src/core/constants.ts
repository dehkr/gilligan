export const STORE_PREFIX = '@';
export const ITEM_PREFIX = '%';
export const KEY_BLOCKLIST = ['__proto__', 'constructor', 'prototype'];

/** Carries the current render item on an `rz-render` instance context. */
export const ITEM_KEY: unique symbol = Symbol('rz.item');
/** Carries per-instance render metadata (`index`, `key`). */
export const ITEM_META_KEY: unique symbol = Symbol('rz.itemMeta');
/** Points an instance context back at the scope/store state it layers over. */
export const RENDER_PARENT: unique symbol = Symbol('rz.renderParent');

/** List of valid HTML DOM swap methods. */
export const SWAP_METHODS = [
  'innerHTML',
  'outerHTML',
  'beforebegin',
  'afterbegin',
  'beforeend',
  'afterend',
  'delete',
] as const;

/** Represents a valid DOM swap method string. */
export type SwapMethod = (typeof SWAP_METHODS)[number];

/** Represents the parameters required to execute a DOM swap. */
export interface SwapOperation {
  targets: Element[];
  method: SwapMethod;
}

/** Resolved `rz-target` value: DOM swap operations plus `@store` target names. */
export interface TargetConfig {
  swaps: SwapOperation[];
  stores: string[];
}

/** Default method for DOM swaps when explicit value isn't provided. */
export const DEFAULT_SWAP_METHOD: SwapMethod = 'innerHTML';

/** Type guard to check if a given string is a valid SwapMethod. */
export function isSwapMethod(key: string): key is SwapMethod {
  return SWAP_METHODS.includes(key as SwapMethod);
}

/** List of valid standard HTTP methods. */
export const HTTP_METHODS = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
] as const;

/** Represents a valid HTTP method string. */
export type HttpMethod = (typeof HTTP_METHODS)[number];

/** Type guard to check if a given string is a valid HttpMethod. */
export function isHttpMethod(key: string | undefined): key is HttpMethod {
  return HTTP_METHODS.includes(key?.toUpperCase() as HttpMethod);
}

/** List of valid store patch methods. */
export const PATCH_ACTIONS = ['replace', 'merge'] as const;

/** Represents a valid store patch method string. */
export type PatchAction = (typeof PATCH_ACTIONS)[number];

/** Type guard to check if a given string is a valid PatchAction. */
export function isPatchAction(key: string | undefined): key is PatchAction {
  return PATCH_ACTIONS.includes(key?.toLowerCase() as PatchAction);
}

/**
 * Bare trigger modifiers that set a boolean `TriggerOptions` field. Each names
 * its field directly except `stop-immediate`, whose kebab-case declarative
 * spelling maps to the camelCase `stopImmediate` at the parse site.
 */
export const FLAG_MODIFIERS = [
  'once',
  'capture',
  'passive',
  'outside',
  'self',
  'loose',
  'ctrl',
  'alt',
  'shift',
  'meta',
  'prevent',
  'stop',
  'stop-immediate',
  'leading',
  'trailing',
] as const;

export type FlagModifier = (typeof FLAG_MODIFIERS)[number];

export const isFlagModifier = (val: string): val is FlagModifier =>
  (FLAG_MODIFIERS as readonly string[]).includes(val);

/** Modifiers naming a host for the listener other than the element itself. */
export const LISTEN_TARGETS = ['window', 'document', 'root'] as const;

export type ListenTarget = (typeof LISTEN_TARGETS)[number];

export const isListenTarget = (val: string): val is ListenTarget =>
  (LISTEN_TARGETS as readonly string[]).includes(val);
