import { warn } from '../core/diagnostics';
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
  const strVal = String(value ?? '');
  if (el.textContent !== strVal) {
    el.textContent = strVal;
  }
}

/**
 * Handles innerHTML updates.
 */
export function updateHtml(el: Element, value: BindableValue) {
  const htmlVal = String(value ?? '');
  if (el.innerHTML !== htmlVal) {
    el.innerHTML = htmlVal;
  }
}

/**
 * Handles setting value of modelable elements.
 */
export function setModelableValue(el: Element, value: BindableValue) {
  if (!(el instanceof HTMLElement)) return;

  // Text of elements with `contenteditable` attribute are modelable
  if (el.isContentEditable) {
    const strVal = String(value ?? '');
    if (el.innerText !== strVal) {
      el.innerText = strVal;
    }
    return;
  }

  if (el instanceof HTMLInputElement) {
    if (el.type === 'checkbox') {
      el.checked = !!value;
    } else if (el.type === 'radio') {
      el.checked = el.value === String(value);
    } else {
      setStringValue(el, value);
    }
    return;
  }

  if (el instanceof HTMLSelectElement) {
    if (el.multiple && Array.isArray(value)) {
      const vals = new Set(value.map(String));
      for (const opt of Array.from(el.options)) {
        opt.selected = vals.has(opt.value);
      }
    } else {
      el.value = value == null ? '' : String(value);
    }
    return;
  }

  if (el instanceof HTMLTextAreaElement) {
    setStringValue(el, value);
    return;
  }

  // Custom or form elements that expose a `value` property
  if ('value' in el) {
    el.value = value;
  }
}

/**
 * Returns current value of HTML element.
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
      return Number.isNaN(el.valueAsNumber) ? null : el.valueAsNumber;
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
 * Set one CSS property to a resolved value. Nullish clears it.
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
 * Handles style attribute updates. Supports object syntax and string value.
 */
export function updateStyle(el: Element, value: BindableValue) {
  if (!canBeStyled(el)) return;

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

/** Checks if an element is a type that can have styles applied to it. */
function canBeStyled(el: Element): el is HTMLElement | SVGElement {
  return el instanceof HTMLElement || el instanceof SVGElement;
}

/** Writes a string value only when it differs, so the caret doesn't jump. */
function setStringValue(
  el: HTMLInputElement | HTMLTextAreaElement,
  value: BindableValue,
) {
  const strVal = String(value ?? '');
  if (el.value !== strVal) {
    el.value = strVal;
  }
}
