import { getApp } from '../core/app';
import { KEY_PREFIX } from '../core/constants';

const isKeyModifier = (m: string) => m.startsWith(KEY_PREFIX);

/**
 * Resolves a `key-` modifier to the `KeyboardEvent.key` value it matches,
 * lowercased. Returns `''` for a bare `key-`, which matches nothing.
 * `e.key` for the spacebar is a literal space.
 */
const resolveKeyToken = (m: string) => {
  const token = m.slice(KEY_PREFIX.length).toLowerCase();
  return token === 'space' ? ' ' : token;
};

const sysModifierMap = {
  ctrl: 'ctrlKey',
  alt: 'altKey',
  shift: 'shiftKey',
  meta: 'metaKey',
} as const;
const SYS_MODIFIER_FLAGS = Object.values(sysModifierMap);

type SystemModifierKey = keyof typeof sysModifierMap;

// The `KeyboardEvent.key` name behind each system modifier flag
const modifierKeyFlags = new Map<string, (typeof SYS_MODIFIER_FLAGS)[number]>([
  ['control', 'ctrlKey'],
  ['alt', 'altKey'],
  ['shift', 'shiftKey'],
  ['meta', 'metaKey'],
]);

/**
 * Maps modifiers to native AddEventListenerOptions.
 */
export function getListenerOptions(modifiers: string[]): AddEventListenerOptions {
  return {
    capture: modifiers.includes('capture'),
    once: modifiers.includes('once'),
    passive: modifiers.includes('passive'),
  };
}

/**
 * Resolves the target of the event listener.
 */
export function resolveListenerTarget(el: Element, modifiers: string[]): EventTarget {
  if (modifiers.includes('window')) {
    return window;
  }
  if (modifiers.includes('document')) {
    return document;
  }
  if (modifiers.includes('root')) {
    return getApp(el)?.root || el;
  }

  // To detect outside clicks, listen on the document
  if (modifiers.includes('outside')) {
    return document;
  }

  return el;
}

/**
 * Applies event modifiers and determines if the handler should execute.
 * By default, modifiers are matched exactly (e.g., `enter` fires only on bare Enter,
 * not Shift+Enter). Use `loose` to allow extra modifiers.
 *
 * @returns `true` if the handler should execute, `false` otherwise
 */
export function applyModifiers(
  e: Event,
  target: EventTarget,
  modifiers: string[],
): boolean {
  if (modifiers.includes('self') && e.target !== e.currentTarget) {
    return false;
  }

  if (modifiers.includes('outside') && target instanceof HTMLElement) {
    if (target.contains(e.target as Node)) {
      return false;
    }
  }

  if (e instanceof KeyboardEvent || e instanceof MouseEvent) {
    const expectedSysModifiers = modifiers.filter((m): m is SystemModifierKey =>
      Object.hasOwn(sysModifierMap, m),
    );

    for (const mod of expectedSysModifiers) {
      if (!e[sysModifierMap[mod]]) {
        return false;
      }
    }

    const keyModifiers =
      e instanceof KeyboardEvent ? modifiers.filter(isKeyModifier) : [];

    // A system modifier qualifies another key rather than filtering on its own. A
    // keyboard trigger without a `key-` token has nothing to qualify, so it's inert.
    // A mouse event still filters on it (`click|ctrl`).
    if (
      e instanceof KeyboardEvent &&
      expectedSysModifiers.length > 0 &&
      keyModifiers.length === 0
    ) {
      return false;
    }

    // Exact matching only applies when the trigger asks for specific keys or
    // modifiers. A bare trigger shouldn't be blocked by a held `shift` or `ctrl`.
    const exact =
      !modifiers.includes('loose') &&
      (expectedSysModifiers.length > 0 || keyModifiers.length > 0);

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

    if (e instanceof KeyboardEvent && keyModifiers.length > 0) {
      const pressedKey = e.key.toLowerCase();
      const pressedCode = e.code.toLowerCase();

      const isMatch = keyModifiers.some((m) => {
        const expected = resolveKeyToken(m);
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
  if (modifiers.includes('prevent')) {
    e.preventDefault();
  }
  if (modifiers.includes('stop')) {
    e.stopPropagation();
  }
  if (modifiers.includes('stop-immediate')) {
    e.stopImmediatePropagation();
  }

  return true;
}
