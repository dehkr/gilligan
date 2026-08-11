import { getApp } from '../core/app';
import type { TriggerOptions } from '../types';

const sysModifierMap = {
  ctrl: 'ctrlKey',
  alt: 'altKey',
  shift: 'shiftKey',
  meta: 'metaKey',
} as const;

type SystemModifierKey = keyof typeof sysModifierMap;

const SYS_MODIFIERS = Object.keys(sysModifierMap) as SystemModifierKey[];
const SYS_MODIFIER_FLAGS = Object.values(sysModifierMap);

// The `KeyboardEvent.key` name behind each system modifier flag
const modifierKeyFlags = new Map<string, (typeof SYS_MODIFIER_FLAGS)[number]>([
  ['control', 'ctrlKey'],
  ['alt', 'altKey'],
  ['shift', 'shiftKey'],
  ['meta', 'metaKey'],
]);

/** Normalizes the `key` option into lowercased `KeyboardEvent.key` values. */
function expectedKeys(key: TriggerOptions['key']): string[] {
  if (key === undefined) return [];
  return (Array.isArray(key) ? key : [key]).map((k) => k.toLowerCase());
}

/**
 * Maps trigger options to native AddEventListenerOptions.
 */
export function getListenerOptions(options: TriggerOptions): AddEventListenerOptions {
  return {
    capture: !!options.capture,
    once: !!options.once,
    passive: !!options.passive,
  };
}

/**
 * Resolves the target of the event listener.
 */
export function resolveListenerTarget(el: Element, options: TriggerOptions): EventTarget {
  if (options.listenOn === 'window') {
    return window;
  }
  if (options.listenOn === 'document') {
    return document;
  }
  if (options.listenOn === 'root') {
    return getApp(el)?.root || el;
  }

  // To detect outside clicks, listen on the document
  if (options.outside) {
    return document;
  }

  return el;
}

/**
 * Applies event filters and determines if the handler should execute.
 * By default, modifiers are matched exactly (e.g., `key-enter` fires only on bare
 * Enter, not Shift+Enter). Use `loose` to allow extra modifiers.
 *
 * @returns `true` if the handler should execute, `false` otherwise
 */
export function applyModifiers(e: Event, el: Element, options: TriggerOptions): boolean {
  if (options.self && e.target !== e.currentTarget) {
    return false;
  }

  if (options.outside && el instanceof Element) {
    if (el.contains(e.target as Node)) {
      return false;
    }
  }

  if (e instanceof KeyboardEvent || e instanceof MouseEvent) {
    const expectedSysModifiers = SYS_MODIFIERS.filter((m) => options[m]);

    for (const mod of expectedSysModifiers) {
      if (!e[sysModifierMap[mod]]) {
        return false;
      }
    }

    const keys = e instanceof KeyboardEvent ? expectedKeys(options.key) : [];

    // A system modifier qualifies another key rather than filtering on its own. A
    // keyboard trigger without a `key` option has nothing to qualify, so it's inert.
    // A mouse event still filters on it (`click|ctrl`).
    if (
      e instanceof KeyboardEvent &&
      expectedSysModifiers.length > 0 &&
      keys.length === 0
    ) {
      return false;
    }

    // Exact matching only applies when the trigger asks for specific keys or
    // modifiers. A bare trigger shouldn't be blocked by a held `shift` or `ctrl`.
    const exact = !options.loose && (expectedSysModifiers.length > 0 || keys.length > 0);

    if (exact) {
      // Pressing a modifier key sets its own flag, so it isn't an extra modifier
      // unless the trigger asked for it. Allows `keydown|key-shift` to work.
      const selfFlag =
        e instanceof KeyboardEvent
          ? modifierKeyFlags.get(e.key.toLowerCase())
          : undefined;

      const expectedFlags = expectedSysModifiers.map((m) => sysModifierMap[m]);

      const pressedModifiers = SYS_MODIFIER_FLAGS.filter(
        (key) => e[key] && (key !== selfFlag || expectedFlags.includes(key)),
      );

      if (pressedModifiers.length !== expectedFlags.length) {
        return false;
      }
    }

    if (e instanceof KeyboardEvent && keys.length > 0) {
      const pressedKey = e.key.toLowerCase();
      const pressedCode = e.code.toLowerCase();

      const isMatch = keys.some((expected) => {
        if (!expected) return false;
        if (pressedKey === expected) return true;

        // Fallback to fix macOS 'alt' dead key
        if (expected.length === 1) {
          if (expected === ' ') {
            return pressedCode === 'space';
          }
          return pressedCode === `key${expected}` || pressedCode === `digit${expected}`;
        }

        return false;
      });

      if (!isMatch) return false;
    }
  }

  // Native API
  if (options.prevent) {
    e.preventDefault();
  }
  if (options.stop) {
    e.stopPropagation();
  }
  if (options.stopImmediate) {
    e.stopImmediatePropagation();
  }

  return true;
}
