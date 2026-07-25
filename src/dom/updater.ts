import { warn } from '../core/diagnostics';
import { is } from '../core/is';
import { parseDeclarations } from '../core/parser';
import type { BindableValue } from '../types';

const prevClasses = new WeakMap<Element, string>();
const prevStyles = new WeakMap<Element, string>();
const warnedProps = new WeakMap<Element, Set<string>>();

/**
 * Handles innerText updates.
 */
export function updateText(el: Element, value: BindableValue) {
  // Check equality to avoid cursor jumping in contenteditable
  const strVal = displayString(value);
  if (el.textContent !== strVal) {
    el.textContent = strVal;
  }
}

/**
 * Handles innerHTML updates.
 */
export function updateHtml(el: Element, value: BindableValue) {
  const htmlVal = displayString(value);
  if (el.innerHTML !== htmlVal) {
    el.innerHTML = htmlVal;
  }
}

/**
 * Handles setting value of modelable elements.
 */
export function setModelableValue(el: Element, value: BindableValue) {
  if (!is(el, 'HTML')) return;

  // Text of elements with `contenteditable` attribute are modelable
  if (el.isContentEditable) {
    const strVal = String(value ?? '');
    if (el.innerText !== strVal) {
      el.innerText = strVal;
    }
    return;
  }

  // Handle input/select elements
  const input = el as HTMLInputElement | HTMLSelectElement;

  // Checkbox
  if (input.type === 'checkbox') {
    input.checked = !!value;
  }

  // Radio buttons
  else if (input.type === 'radio') {
    input.checked = input.value === String(value);
  }

  // Select (single or multiple)
  else if (is(input, 'Select')) {
    if (input.multiple && Array.isArray(value)) {
      const vals = new Set(value.map(String));
      Array.from(input.options).forEach((opt) => {
        opt.selected = vals.has(opt.value);
      });
    } else {
      input.value = value == null ? '' : String(value);
    }
  }

  // Standard inputs (string value)
  else if (is(input, 'Input') || is(input, 'TextArea')) {
    const strVal = String(value ?? '');
    // Only update if actually changed to prevent cursor jumping
    if (input.value !== strVal) {
      input.value = strVal;
    }
  }

  // Custom or form elements that expose a `value` property
  else if ('value' in el) {
    el.value = value;
  }
}

/**
 * Returns current value of HTML element.
 */
export function getModelableValue(el: Element): BindableValue {
  if (!is(el, 'HTML')) return;

  // Text of elements with `contenteditable` attribute are modelable
  if (el.isContentEditable) {
    return el.innerText;
  }

  const input = el as HTMLInputElement | HTMLSelectElement;

  if (input.type === 'checkbox') {
    return (input as HTMLInputElement).checked;
  }
  if (input.type === 'number' || input.type === 'range') {
    return Number.isNaN(input.valueAsNumber) ? null : input.valueAsNumber;
  }
  if (is(input, 'Select') && input.multiple) {
    return Array.from(input.selectedOptions).map((o) => o.value);
  }

  return input.value;
}

/**
 * Handles class attribute updates.
 * Object syntax toggles class: `{ 'active': bool }` or `{ 'active bg-red: bool' }`.
 * String value swaps class w/out replacing existing classes: 'active' or 'active bg-red'.
 */
export function updateClass(el: Element, value: BindableValue) {
  if (value && typeof value === 'object') {
    for (const [cls, active] of Object.entries(value)) {
      const classes = cls.trim().split(/\s+/).filter(Boolean);

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
      el.classList.remove(...oldClass.split(/\s+/));
    }

    if (newClass) {
      const classes = newClass.split(/\s+/).filter(Boolean);
      if (classes.length) {
        el.classList.add(...classes);
        prevClasses.set(el, newClass);
      }
    } else {
      prevClasses.delete(el);
    }
  }
}

/**
 * Add or remove every declaration in a style string, leaving other props intact.
 */
export function applyStyles(el: Element, decl: string, active: boolean) {
  if (!(is(el, 'HTML') || is(el, 'SVG'))) return;

  for (const [prop, value] of parseDeclarations(decl)) {
    if (active) {
      el.style.setProperty(prop, value);
    } else {
      el.style.removeProperty(prop);
    }
  }
}

/**
 * Set one CSS property to a resolved value. Nullish clears it.
 */
export function setStyleProperty(el: Element, prop: string, value: BindableValue) {
  if (!(is(el, 'HTML') || is(el, 'SVG'))) return;

  if (value == null) {
    el.style.removeProperty(prop);
  } else {
    el.style.setProperty(prop, String(value));
  }
}

/**
 * Handles style attribute updates. Supports object syntax and string value.
 */
export function updateStyle(el: Element, value: BindableValue) {
  if (!(is(el, 'HTML') || is(el, 'SVG'))) return;

  if (value && typeof value === 'object') {
    Object.assign(el.style, value);
    return;
  }

  const next = String(value ?? '').trim();
  const prev = prevStyles.get(el);

  if (prev) {
    applyStyles(el, prev, false);
  }

  if (next) {
    applyStyles(el, next, true);
    prevStyles.set(el, next);
  } else {
    prevStyles.delete(el);
  }
}

/**
 * Handles generic attribute updates.
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
 * Converts bindable values into strings for improved output of JSON/data.
 */
function displayString(value: BindableValue): string {
  if (value == null) return '';

  if (typeof value === 'object') {
    // Handle dates
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toLocaleString();
    }

    // Format flat arrays of primitives for readability
    if (Array.isArray(value)) {
      const isFlat = value.every((item) => item == null || typeof item !== 'object');

      if (isFlat) {
        return value.filter((v) => v != null).join(', ');
      }
    }

    // Stringify objects and complex arrays
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return '[Circular reference]';
    }
  }

  // Standard primitives
  return String(value);
}
