import { internalBus } from './bus';
import { effect, reactive } from './reactivity';
import type { GilliEvent } from './types';

interface GilliController extends Controller {
  [key: string]: unknown; 
}

export class Controller {
  public el: HTMLElement;
  public refs: Record<string, HTMLElement> = {};

  public _state: any;
  public _computedCache: any;
  private _cleanupMap = new WeakMap<HTMLElement, (() => void)[]>();
  private _observer: MutationObserver | null = null;

  public connect?(): void;
  public disconnect?(): void;

  // State and config values can be passed in from html
  // They overwrite defaults in controller
  constructor(el: HTMLElement, htmlState: any = {}, htmlConfig: any = {}) {
    this.el = el;
    const ctor = this.constructor as any;

    // Initialize internal reactive state
    this._state = reactive({ ...ctor.state, ...htmlState });
    this._computedCache = reactive({});

    // Flatten state onto 'this'
    Object.keys(this._state).forEach((key) => {
      // Collision guard
      if (key in this) {
        console.warn(
          `[Gilligan] Property collision: "${key}" already exists on the controller.`,
        );
        return;
      }
      Object.defineProperty(this, key, {
        get: () => this._state[key],
        set: (val) => {
          this._state[key] = val;
        },
        configurable: true,
        enumerable: true,
      });
    });

    // Flatten config onto 'this'
    const config = { ...ctor.config, ...htmlConfig };
    Object.keys(config).forEach((key) => {
      // Collision guard
      if (key in this) {
        console.warn(
          `[Gilligan] Property collision: "${key}" already exists on the controller or in state.`,
        );
        return;
      }
      // Config props are read-only so only get is defined
      Object.defineProperty(this, key, {
        get: () => config[key],
        configurable: true,
        enumerable: true,
      });
    });

    this._initComputed(ctor.computed || {});
  }

  public mount() {
    this._mapRefs();

    // Initialize on current DOM
    this._initBindings(this.el);
    this._initEvents(this.el);

    // Watch for future DOM
    this._observeDOM();

    if (this.connect) {
      this.connect();
    }
  }

  public unmount() {
    if (this.disconnect) {
      this.disconnect();
    }

    // Stop watching the DOM
    if (this._observer) {
      this._observer.disconnect();
      this._observer = null;
    }

    // Clean up listeners and effects
    this._performCleanup(this.el);
    this.refs = {};
  }

  protected listen(event: string, callback: (payload: any) => void) {
    const unsubscribe = internalBus.on(event, callback.bind(this));
    this._registerCleanup(this.el, unsubscribe);
  }

  private _observeDOM() {
    this._observer = new MutationObserver((mutations) => {
      mutations.forEach((m) => {
        m.removedNodes.forEach((node) => {
          if (node instanceof HTMLElement) this._performCleanup(node);
        });
        m.addedNodes.forEach((node) => {
          if (node instanceof HTMLElement) {
            if (node.dataset.gx) return;
            this._initBindings(node);
            this._initEvents(node);
            this._mapRefs();
          }
        });
      });
    });
    this._observer.observe(this.el, { childList: true, subtree: true });
  }

  private _performCleanup(el: HTMLElement) {
    // Clean the node itself
    const run = (node: HTMLElement) => {
      const cleanups = this._cleanupMap.get(node);
      if (cleanups) {
        cleanups.forEach((fn) => {
          fn();
        });
        this._cleanupMap.delete(node);
      }
    };
    run(el);
    // Clean all children
    el.querySelectorAll('*').forEach((node) => {
      if (node instanceof HTMLElement) {
        run(node);
      }
    });
  }

  private _registerCleanup(el: HTMLElement, fn: () => void) {
    const list = this._cleanupMap.get(el) || [];
    list.push(fn);
    this._cleanupMap.set(el, list);
  }

  private _initEvents(root: HTMLElement) {
    const elements = [root, ...Array.from(root.querySelectorAll<HTMLElement>('[data-gx-on]'))];

    elements.forEach((el) => {
      if (el !== this.el && el.closest('[data-gx]') !== this.el) return;

      const events = el.dataset.gxOn?.split(',') || [];
      events.forEach((inst) => {
        let [evtName, funcName] = inst.split(':');
        evtName = evtName.trim();
        funcName = funcName.trim();

        const self = this as unknown as GilliController;
        const potentialHandler = self[funcName];

        if (typeof potentialHandler === 'function') {
          const handler = (e: Event) => {
            Object.defineProperty(e, 'el', { value: el, configurable: true });
            potentialHandler.call(this, e as GilliEvent);
          };
          el.addEventListener(evtName, handler);
          this._registerCleanup(el, () => el.removeEventListener(evtName, handler));
        } else {
          console.warn(`[Gilligan] Method "${funcName}" not found.`);
        }
      });
    });
  }

  private _initBindings(root: HTMLElement) {
    const elements = [root, ...Array.from(root.querySelectorAll<HTMLElement>('[data-gx-bind]'))];

    elements.forEach((el) => {
      if (el !== this.el && el.closest('[data-gx]') !== this.el) return;

      const bindings = el.dataset.gxBind?.split(',') || [];
      bindings.forEach((inst) => {
        let [bindType, objKey] = inst.split(':');
        bindType = bindType.trim();
        objKey = objKey.trim();

        // Reactive update: state updates DOM
        const stopEffect = effect(() => {
          const value = this._resolveValue(objKey);
          this._updateDOM(el, bindType, value);
        });
        this._registerCleanup(el, stopEffect);

        // Two-way bindings: DOM updates state
        if (bindType === 'value') {
          const isInput = el instanceof HTMLInputElement;
          const isTextArea = el instanceof HTMLTextAreaElement;
          const isSelect = el instanceof HTMLSelectElement;

          if (isInput || isTextArea || isSelect) {
            // Detect "change" for lazy inputs/selects, "input" for instant typing
            // Standardizing on 'input' event covers most cases
            const evtType =
              isSelect || (isInput && (el.type === 'checkbox' || el.type === 'radio'))
                ? 'change'
                : 'input';

            const inputHandler = () => {
              let newVal: unknown;

              if (isInput && el.type === 'checkbox') {
                // Checkbox: toggle boolean
                newVal = el.checked;
              } else if (isInput && (el.type === 'number' || el.type === 'range')) {
                // Number/Range: parse float
                newVal = parseFloat(el.value);
                if (Number.isNaN(newVal)) newVal = 0;
              } else {
                // Text, Radio, Select, Textarea: string value
                newVal = el.value;
              }

              // Update state
              (this as any)[objKey] = newVal;
            };

            el.addEventListener(evtType, inputHandler);
            this._registerCleanup(el, () => el.removeEventListener(evtType, inputHandler));
          }
        }
      });
    });
  }

  private _initComputed(schema: Record<string, Function>) {
    Object.keys(schema).forEach((key) => {
      // Collision guard
      if (key in this) {
        console.warn(
          `[Gilligan] Property collision: "${key}" already exists on the controller or in state or config.`,
        );
        return;
      }

      const fn = schema[key];
      // Will run once immediately then whenever 'this.state' props change
      effect(() => {
        // Pass 'this' so 'state.count' or 'this.count' can be used inside controller
        this._computedCache[key] = fn.call(this, this);
      });
      // Define getter on instance so computed props are read from the reactive cache
      // No cleanup here because computed props live as long as controller lives
      Object.defineProperty(this, key, {
        get: () => this._computedCache[key],
        configurable: true,
        enumerable: true,
      });
    });
  }

  private _mapRefs() {
    const elements = [
      this.el,
      ...Array.from(this.el.querySelectorAll<HTMLElement>('[data-gx-ref]')),
    ];
    elements.forEach((el) => {
      if (el === this.el || el.closest('[data-gx]') === this.el) {
        if (el.dataset.gxRef) this.refs[el.dataset.gxRef] = el;
      }
    });
  }

  private _resolveValue(key: string): unknown {
    const self = this as unknown as GilliController;
    const value = self[key];

    if (typeof value === 'function') {
      return value.call(this);
    }

    return value;
  }

  private _updateDOM(el: HTMLElement, type: string, value: any) {
    if (type === 'text') {
      el.textContent = value ?? '';
      return;
    }

    if (type === 'html') {
      el.innerHTML = value ?? '';
      return;
    }

    if (type === 'class') {
      if (value !== null && typeof value === 'object') {
        Object.entries(value).forEach(([names, cond]) => {
          names
            .split(' ')
            .filter(Boolean)
            .forEach((n) => {
              el.classList.toggle(n, !!cond);
            });
        });
      }
      return;
    }

    if (type === 'style') {
      if (typeof value === 'object' && value !== null) {
        // Object syntax { color: 'red', 'font-size': '12px' }
        // This merges with existing styles instead of wiping them
        Object.assign(el.style, value);
      } else {
        // String syntax: "color: red"
        // This overwrites existing styles
        el.style.cssText = String(value);
      }
      return;
    }

    // Two-way binding
    if (type === 'value') {
      if (el instanceof HTMLInputElement) {
        // Checkbox: boolean check
        if (el.type === 'checkbox') {
          el.checked = !!value;
          return;
        }
        // Radio: selection match
        if (el.type === 'radio') {
          el.checked = el.value === String(value);
          return;
        }
      }

      // Text/Range/Select/Textarea: set value
      // Only update if different to prevent cursor jumping
      if ((el as any).value !== String(value ?? '')) {
        (el as any).value = value ?? '';
      }
      return;
    }

    // Boolean attributes (hidden, disabled, checked, required, readonly, etc.)
    if (typeof value === 'boolean') {
      if (value) {
        el.setAttribute(type, '');
      } else {
        el.removeAttribute(type);
      }
      return;
    }

    // Standard attributes (src, href, id, aria-*, etc.)
    if (value === null || value === undefined || value === false) {
      el.removeAttribute(type);
    } else {
      el.setAttribute(type, String(value));
    }
  }
}
