import { internalBus } from './bus';
import { Controller } from './controller';
import { handleFetch } from './fetch';
import { createStore } from './store';

const registry: Record<string, typeof Controller> = {};
const instanceMap = new WeakMap<HTMLElement, Controller>();

// Helper to parse JSON from string or script ID
const safeParse = (input: string | undefined) => {
  if (!input) {
    return {};
  }

  if (input.startsWith('#')) {
    const el = document.querySelector(input);
    if (el) {
      try {
        return JSON.parse(el.textContent || '{}');
      } catch (e) {
        console.warn(`[Gilligan] Failed to parse JSON from ${input}:`, e);
        return {};
      }
    }
  }

  try {
    return JSON.parse(input);
  } catch {
    return {};
  }
};

const mount = (el: HTMLElement) => {
  const name = el.dataset.gx;
  if (name && registry[name] && !instanceMap.has(el)) {
    try {
      const state = safeParse(el.dataset.gxState);
      const config = safeParse(el.dataset.gxConfig);
      const inst = new registry[name](el, state, config);
      instanceMap.set(el, inst);
      inst.mount();
    } catch (e) {
      console.error(`[Gilligan] Failed to mount "${name}":`, e);
    }
  }
};

const unmount = (el: HTMLElement) => {
  const inst = instanceMap.get(el);
  if (inst) {
    inst.unmount();
    instanceMap.delete(el);
  }
};

const Gilligan = {
  register: (name: string, controllerClass: typeof Controller) => {
    registry[name] = controllerClass;
  },

  start: (manifest: Record<string, typeof Controller> = {}) => {
    Object.entries(manifest).forEach(([name, cls]) => {
      Gilligan.register(name, cls);
    });

    const fetchEvents = ['click', 'submit'];

    const handleGlobalFetch = (e: Event) => {
      const target = (e.target as HTMLElement).closest<HTMLElement>('[data-gx-fetch]');
      if (!target) return;

      const isForm = target.tagName === 'FORM';
      const isSubmit = e.type === 'submit' && isForm;
      const isClick = e.type === 'click' && !isForm;

      if (isSubmit || isClick) {
        e.preventDefault();
        handleFetch(target);
      }
    };

    fetchEvents.forEach((evt) => {
      document.addEventListener(evt, handleGlobalFetch);
    });

    const observer = new MutationObserver((mutations) => {
      mutations.forEach((m) => {
        m.removedNodes.forEach((node) => {
          if (node instanceof HTMLElement) {
            if (node.dataset.gx) unmount(node);
            node.querySelectorAll<HTMLElement>('[data-gx]').forEach(unmount);
          }
        });
        m.addedNodes.forEach((node) => {
          if (node instanceof HTMLElement) {
            if (node.dataset.gx) mount(node);
            node.querySelectorAll<HTMLElement>('[data-gx]').forEach(mount);
          }
        });
      });
    });

    observer.observe(document.body, { childList: true, subtree: true });
    document.querySelectorAll<HTMLElement>('[data-gx]').forEach(mount);
  },

  store: createStore,
  emit: internalBus.emit.bind(internalBus),
  on: internalBus.on.bind(internalBus),
  off: internalBus.off.bind(internalBus),
};

export { Gilligan, Controller };
