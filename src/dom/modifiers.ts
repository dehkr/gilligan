import { getApp } from '../core/app';

const keyTokens = new Set(
  'enter tab delete backspace home end pageup pagedown insert f1 f2 f3 f4 f5 f6 f7 f8 f9 f10 f11 f12'.split(
    ' ',
  ),
);

const keyAliases: Record<string, string> = {
  esc: 'escape',
  space: ' ',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
};

const isKeyToken = (m: string) => keyTokens.has(m) || m in keyAliases;

const sysModifierMap = {
  ctrl: 'ctrlKey',
  alt: 'altKey',
  shift: 'shiftKey',
  meta: 'metaKey',
} as const;
const SYS_MODIFIER_FLAGS = Object.values(sysModifierMap);

type SystemModifierKey = keyof typeof sysModifierMap;

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
  // Target/UI filtering
  if (modifiers.includes('self') && e.target !== e.currentTarget) {
    return false;
  }

  if (modifiers.includes('outside') && target instanceof HTMLElement) {
    if (target.contains(e.target as Node)) {
      return false;
    }
  }

  // System modifier and key checks
  if (e instanceof KeyboardEvent || e instanceof MouseEvent) {
    const expectedSysModifiers = modifiers.filter(
      (m): m is SystemModifierKey => m in sysModifierMap,
    );

    // Check required modifiers are pressed
    for (const mod of expectedSysModifiers) {
      if (!e[sysModifierMap[mod]]) {
        return false;
      }
    }

    const hasKeyModifier =
      e instanceof KeyboardEvent &&
      modifiers.some((m) => isKeyToken(m) || m.length === 1);

    // Exact matching only applies when the trigger asks for specific keys or
    // modifiers. A bare trigger shouldn't be blocked by a held `shift` or `ctrl`.
    const exact =
      !modifiers.includes('loose') && (expectedSysModifiers.length > 0 || hasKeyModifier);

    if (exact) {
      const pressedModifiers = SYS_MODIFIER_FLAGS.filter((key) => e[key]);
      if (pressedModifiers.length !== expectedSysModifiers.length) {
        return false;
      }
    }

    // Key filtering
    if (e instanceof KeyboardEvent && hasKeyModifier) {
      const pressedKey = e.key.toLowerCase();
      const pressedCode = e.code.toLowerCase();

      // Find if any modifier matches the key pressed
      const isMatch = modifiers.some((m) => {
        if (m in sysModifierMap) return false;

        const expected = keyAliases[m] ?? m.toLowerCase();
        if (pressedKey === expected) return true;

        // Fallback to fix macOS 'alt' dead key
        if (expected.length === 1) {
          if (expected === ' ' && pressedCode === 'space') return true;

          return pressedCode === `key${expected}` || pressedCode === `digit${expected}`;
        }

        return false;
      });

      if (!isMatch) {
        return false;
      }
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
