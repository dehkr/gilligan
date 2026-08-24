import { warn } from '../core/diagnostics';
import { parseDeclarations } from '../core/parser';
import type { BindableValue } from '../types';

/** Last markup written by `updateHtml`, compared instead of re-reading the DOM. */
const prevHtml = new WeakMap<Element, string>();
/** Last class string written by `updateClass`, so the next write can remove it. */
const prevClasses = new WeakMap<Element, string>();
/** Property names written by `updateStyle`, so the next write clears exactly those. */
const prevStyles = new WeakMap<Element, string[]>();
/** Properties already reported, so each `rz-prop` failure warns once. */
const warnedProps = new WeakMap<Element, Set<string>>();

/** Converts a camelCase style key to CSS version. Custom properties pass through. */
const toKebab = (k: string) =>
  k.startsWith('--') ? k : k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** White space regex. */
const WS = /\s+/;

/**
 * Writes text content, skipping the write when it already matches.
 *
 * Unlike `updateHtml` this compares the live DOM rather than a cache, since the
 * user may write here too.
 */
export function updateText(el: Element, value: BindableValue) {
  setStringValue(el, 'textContent', value);
}

/**
 * Replaces markup, skipping the write when it already matches.
 *
 * Compared against the last written value rather than reading `innerHTML`, which would
 * serialize the whole subtree on every update.
 */
export function updateHtml(el: Element, value: BindableValue) {
  const htmlVal = String(value ?? '');
  if (prevHtml.get(el) === htmlVal) return;

  prevHtml.set(el, htmlVal);
  el.innerHTML = htmlVal;
}

/**
 * Writes a value into a form control or contenteditable, dispatching on element type.
 * Text-like inputs write only when the value differs, so the caret doesn't jump.
 */
export function setModelableValue(el: Element, value: BindableValue) {
  if (!(el instanceof HTMLElement)) return;

  if (el.isContentEditable) {
    setStringValue(el, 'innerText', value);
    return;
  }

  if (el instanceof HTMLInputElement) {
    if (el.type === 'checkbox') {
      el.checked = !!value;
    } else if (el.type === 'radio') {
      el.checked = el.value === String(value);
    } else {
      setStringValue(el, 'value', value);
    }
    return;
  }

  if (el instanceof HTMLSelectElement) {
    if (el.multiple && Array.isArray(value)) {
      const vals = new Set(value.map(String));
      for (const opt of el.options) {
        opt.selected = vals.has(opt.value);
      }
    } else {
      el.value = value == null ? '' : String(value);
    }
    return;
  }

  if (el instanceof HTMLTextAreaElement) {
    setStringValue(el, 'value', value);
    return;
  }

  // Custom or form elements that expose a `value` property
  if ('value' in el) {
    el.value = value;
  }
}

/**
 * Reads the current value out of a form control or contenteditable. Checkboxes yield
 * a boolean; number and range inputs a number, or `undefined` when empty; multi-selects
 * an array.
 */
export function getModelableValue(el: Element): BindableValue {
  if (!(el instanceof HTMLElement)) return;

  if (el.isContentEditable) {
    return el.innerText;
  }

  if (el instanceof HTMLInputElement) {
    if (el.type === 'checkbox') {
      return el.checked;
    }
    if (el.type === 'number' || el.type === 'range') {
      return Number.isNaN(el.valueAsNumber) ? undefined : el.valueAsNumber;
    }
    return el.value;
  }

  if (el instanceof HTMLSelectElement) {
    return el.multiple ? Array.from(el.selectedOptions).map((o) => o.value) : el.value;
  }

  if (el instanceof HTMLTextAreaElement) {
    return el.value;
  }

  // Custom or form elements that expose a `value` property
  return 'value' in el ? (el.value as BindableValue) : undefined;
}

/**
 * Applies a class binding. An object toggles each key by its truthiness:
 * `{ 'active bg-red': bool }`; a string swaps only the classes this binding last wrote,
 * leaving pre-existing classes in the markup intact.
 */
export function updateClass(el: Element, value: BindableValue) {
  if (value && typeof value === 'object') {
    for (const [cls, active] of Object.entries(value)) {
      const classes = cls.trim().split(WS).filter(Boolean);

      if (classes.length > 0) {
        if (active) {
          el.classList.add(...classes);
        } else {
          el.classList.remove(...classes);
        }
      }
    }
  } else {
    const newClass = String(value ?? '').trim();
    const oldClass = prevClasses.get(el);

    if (oldClass) {
      el.classList.remove(...oldClass.split(WS));
    }

    if (newClass) {
      el.classList.add(...newClass.split(WS));
      prevClasses.set(el, newClass);
    } else {
      prevClasses.delete(el);
    }
  }
}

/**
 * Adds or removes every declaration in a style string, leaving other properties intact.
 */
export function applyStyles(el: Element, decl: string, active: boolean) {
  if (!canBeStyled(el)) return;

  for (const [prop, value] of parseDeclarations(decl)) {
    if (active) {
      el.style.setProperty(prop, value);
    } else {
      el.style.removeProperty(prop);
    }
  }
}

/**
 * Sets one CSS property to a resolved value. Null or undefined clears it.
 */
export function setStyleProperty(el: Element, prop: string, value: BindableValue) {
  if (!canBeStyled(el)) return;

  if (value == null) {
    el.style.removeProperty(prop);
  } else {
    el.style.setProperty(prop, String(value));
  }
}

/**
 * Applies a style binding from either an object or a declaration string.
 *
 * Clears properties the previous call wrote first so keys dropped between updates don't
 * linger. Both forms route through `setProperty`, so custom properties work in each.
 */
export function updateStyle(el: Element, value: BindableValue) {
  if (!canBeStyled(el)) return;

  for (const prop of prevStyles.get(el) ?? []) {
    el.style.removeProperty(prop);
  }

  const entries: Array<[string, string]> =
    value && typeof value === 'object'
      ? Object.entries(value)
          .filter(([, v]) => v != null)
          .map(([k, v]) => [toKebab(k), String(v)])
      : parseDeclarations(String(value ?? ''));

  for (const [prop, v] of entries) {
    el.style.setProperty(prop, v);
  }

  if (entries.length) {
    prevStyles.set(
      el,
      entries.map(([prop]) => prop),
    );
  } else {
    prevStyles.delete(el);
  }
}

/**
 * Writes an attribute. `false` and nullish remove it; `true` sets the empty string,
 * matching how boolean HTML attributes are spelled.
 */
export function updateAttr(el: Element, attr: string, value: BindableValue) {
  if (value === false || value == null) {
    el.removeAttribute(attr);
  } else {
    el.setAttribute(attr, value === true ? '' : String(value));
  }
}

/**
 * Assigns a value to an element property. A read-only property or one with no
 * setter fails silently rather than throwing, so the failure is reported once.
 */
export function updateProp(el: Element, name: string, value: BindableValue) {
  if (Reflect.set(el, name, value)) return;
  __DEV__ && warnPropOnce(el, name);
}

/**
 * Dedupes `rz-prop` repeat warnings per element/property.
 */
function warnPropOnce(el: Element, name: string): void {
  let seen = warnedProps.get(el);
  if (!seen) {
    seen = new Set();
    warnedProps.set(el, seen);
  }
  if (seen.has(name)) return;
  seen.add(name);
  warn(`rz-prop: cannot set property '${name}'. It is read-only or has no setter.`, el);
}

/**
 * Checks if an element exposes an inline style declaration.
 */
function canBeStyled(el: Element): el is Element & ElementCSSInlineStyle {
  return 'style' in el;
}

/**
 * Writes a string property only when it differs. The comparison reads the live DOM
 * because the user may be editing it too (a contenteditable, a focused input), and
 * skipping redundant writes prevents the caret from jumping.
 */
function setStringValue<K extends string>(
  el: Record<K, string | null>,
  prop: K,
  value: BindableValue,
) {
  const strVal = String(value ?? '');
  if (el[prop] !== strVal) {
    el[prop] = strVal;
  }
}
