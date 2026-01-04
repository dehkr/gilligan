import { internalBus } from './bus';
import { effect } from './reactivity';
import { dispatch, safeParse } from './utils';
import type { BindableValue, BusCallback, SetupContext } from './types';

/**
 * Composes multiple setup functions into a single setup function.
 * Used when an element has multiple controllers (e.g. data-gn="foo bar").
 */
export function composeSetups(setupFns: Function[]) {
  if (setupFns.length === 0) return () => ({});
  if (setupFns.length === 1) return setupFns[0];

  return (context: SetupContext) => {
    const results = setupFns.map((fn) => fn(context));
    const composed: any = {};
    const connects: Function[] = [];
    const disconnects: Function[] = [];

    results.forEach((res) => {
      if (!res) return;

      // Use getOwnPropertyDescriptors to preserve getters/setters when merging.
      const descriptors = Object.getOwnPropertyDescriptors(res);
      Object.keys(descriptors).forEach((key) => {
        if (key !== 'connect' && key !== 'disconnect') {
          Object.defineProperty(composed, key, descriptors[key]);
        }
      });

      if (typeof res.connect === 'function') {
        connects.push(res.connect);
      }
      if (typeof res.disconnect === 'function') {
        disconnects.push(res.disconnect);
      }
    });

    if (connects.length > 0) {
      composed.connect = () => {
        connects.forEach((fn) => fn());
      };
    }

    if (disconnects.length > 0) {
      composed.disconnect = () => {
        disconnects.forEach((fn) => fn());
      };
    }

    return composed;
  };
}

/**
 * The core factory function. Turns a setup function into a controller instance.
 */
export function createController(el: HTMLElement, setupFn: Function) {
  if (typeof setupFn !== 'function') {
    throw new Error('[Gilligan] createController requires a setup function.');
  }

  const refs: Record<string, HTMLElement> = {};
  const refElements = [el, ...Array.from(el.querySelectorAll<HTMLElement>('[data-gn-ref]'))];

  refElements.forEach((refEl) => {
    if (refEl === el || refEl.closest('[data-gn]') === el) {
      const name = refEl.dataset.gnRef;
      if (name) {
        refs[name] = refEl;
      }
    }
  });

  const props = safeParse(el.dataset.gnProps);

  const context: SetupContext = {
    el,
    refs,
    props,
    dispatch: (name: string, detail: any = {}) => dispatch(el, name, detail),
  };

  const api = setupFn(context);

  const instance: any = {
    el,
    refs,
    cleanup: (fn: () => void) => cleanups.push(fn),
    _resolveHtmlKey: (key: string) => instance[key],
  };

  // Copy user API properties to preserve getters/setters.
  const descriptors = Object.getOwnPropertyDescriptors(api);
  Object.defineProperties(instance, descriptors);

  const cleanups: (() => void)[] = [];

  instance.listen = <T>(event: string, callback: BusCallback<T>) => {
    const boundCallback = callback.bind(instance);
    const unsubscribe = internalBus.on(event, boundCallback);
    instance.cleanup(unsubscribe);
  };

  instance._unmount = () => {
    if (instance.disconnect) instance.disconnect();
    cleanups.forEach((fn) => fn());
  };

  initBindings(instance);
  initEvents(instance);

  if (instance.connect) {
    instance.connect();
  }

  return instance;
}

/**
 * Scans the DOM for 'data-gn-bind' attributes and sets up reactive effects.
 * Supports one-way (->) and two-way (<->) bindings.
 */
function initBindings(instance: any) {
  const root = instance.el as HTMLElement;
  const elements = [root, ...Array.from(root.querySelectorAll<HTMLElement>('[data-gn-bind]'))];

  elements.forEach((el) => {
    if (el !== root && el.closest('[data-gn]') !== root) return;

    const rawBindings = el.dataset.gnBind || '';
    const bindings = rawBindings.trim().split(/\s+/);

    bindings.forEach((inst) => {
      if (!inst) return;

      // Detect binding direction.
      const isTwoWay = inst.includes('<->');
      const separator = isTwoWay ? '<->' : '->';
      const separatorIndex = inst.indexOf(separator);

      if (separatorIndex === -1) return;

      const bindType = inst.slice(0, separatorIndex);
      const key = inst.slice(separatorIndex + separator.length);

      // Set up DOM updates (one-way).
      // Runs for both one-way and two-way bindings.
      const stopEffect = effect(() => {
        const value = instance._resolveHtmlKey(key);
        updateDOM(el, bindType, value as BindableValue);
      });
      instance.cleanup(stopEffect);

      // Attach input or change listeners to form elements (inputs,
      // selects, textareas) for two-way data binding.
      if (isTwoWay) {
        const isInput = el instanceof HTMLInputElement;
        const isSelect = el instanceof HTMLSelectElement;
        const isContentEditable = el.isContentEditable;

        if (isInput || isContentEditable) {
          let evtType = 'input';
          const isCheckable = isInput && (el.type === 'checkbox' || el.type === 'radio');
          
          if (isSelect || isCheckable) {
            evtType = 'change';
          }

          const handler = () => {
            let newVal: unknown;

            if (isContentEditable) {
              // Map based on the binding type (text vs html).
              if (bindType === 'html') {
                newVal = el.innerHTML;
              } else {
                newVal = el.textContent;
              }
            } else if (isInput) {
              const inputEl = el as HTMLInputElement;
              if (inputEl.type === 'checkbox' && bindType === 'checked') {
                newVal = inputEl.checked;
              } else if (inputEl.type === 'number') {
                newVal = parseFloat(inputEl.value) || 0;
              } else {
                // Some frameworks alias this to checked.
                // Gilligan is strict: value maps to value, checked maps to checked.
                newVal = inputEl.value;
              }
            }

            try {
              instance[key] = newVal;
            } catch (err) {
              console.warn(`[Gilligan] Unable to update "${key}". Ensure it has a setter.`, err);
            }
          };

          el.addEventListener(evtType, handler);
          instance.cleanup(() => el.removeEventListener(evtType, handler));
        }
      }
    });
  });
}

/**
 * Scans the DOM for 'data-gn-on' attributes and attaches event listeners.
 */
function initEvents(instance: any) {
  const root = instance.el as HTMLElement;
  const elements = [root, ...Array.from(root.querySelectorAll<HTMLElement>('[data-gn-on]'))];

  elements.forEach((el) => {
    if (el !== root && el.closest('[data-gn]') !== root) return;

    const rawEvents = el.dataset.gnOn || '';
    const events = rawEvents.trim().split(/\s+/);

    events.forEach((inst) => {
      if (!inst || inst === '') return;
      const [evtName, funcName] = inst.split('->');
      if (!evtName || !funcName) return;

      const handlerFn = instance._resolveHtmlKey(funcName);

      if (typeof handlerFn === 'function') {
        const handler = (e: Event) => {
          Object.defineProperty(e, 'el', { value: el, configurable: true, writable: true });
          handlerFn(e);
        };
        el.addEventListener(evtName, handler);
        instance.cleanup(() => el.removeEventListener(evtName, handler));
      } else {
        console.warn(`[Gilligan] Action "${funcName}" not found.`);
      }
    });
  });
}

/**
 * Direct DOM manipulation utility used by reactive effects.
 */
function updateDOM(el: HTMLElement, type: string, value: BindableValue) {
  // For text and html, compare if current val is different before 
  // writing to address cursor jumping for contenteditable.
  if (type === 'text') {
    const strValue = String(value ?? '');
    if (el.textContent !== strValue) {
      el.textContent = strValue;
    }
    return;
  }

  if (type === 'html') {
    const strValue = String(value ?? '');
    if (el.innerHTML !== strValue) {
      el.innerHTML = strValue;
    }
    return;
  }

  // Object syntax: merges properties into el.style (additive).
  // String syntax: overwrites el.style.cssText entirely (destructive).
  if (type === 'style') {
    if (typeof value === 'object' && value !== null) {
      Object.assign(el.style, value);
    } else {
      el.style.cssText = String(value ?? '');
    }
    return;
  }

  // Object syntax: toggles individual classes based on truthiness (fine-grained).
  // String syntax: replaces the entire class attribute (bulk update).
  if (type === 'class') {
    if (typeof value === 'object' && value !== null) {
      Object.entries(value).forEach(([cls, active]) => {
        cls
          .split(' ')
          .filter(Boolean)
          .forEach((c) => el.classList.toggle(c, !!active));
      });
    } else {
      el.className = String(value ?? '');
    }
    return;
  }

  // Synchronizes form inputs. We check (el.value !== newValue) to prevent 
  // the cursor from snapping to the end of the field on every keystroke.
  if (type === 'value' && (el as any).value !== String(value ?? '')) {
    (el as any).value = value ?? '';
    return;
  }

  // Explicitly handles checkboxes and radio buttons.
  if (type === 'checked' && el instanceof HTMLInputElement) {
    el.checked = !!value;
    return; 
  }

  // Handles boolean (disabled, hidden, required) and standard attributes (src, href).
  // - false/null/undefined: removes the attribute.
  // - true: sets as a minimized boolean attribute (e.g. disabled="").
  // - string/number: sets the attribute to the stringified value.
  if (value == null || value === false) {
    el.removeAttribute(type);
  } else {
    el.setAttribute(type, value === true ? '' : String(value));
  }
}

/**
 * Defines a new controller.
 * Identity function for TypeScript inference.
 */
export function controller<T>(setupFn: (ctx: SetupContext) => T): (ctx: SetupContext) => T {
  return setupFn;
}
