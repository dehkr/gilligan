import { internalBus } from './bus';
import { createController, composeSetups, controller } from './controller';
import { reactive, effect } from './reactivity';
import { handleFetch } from './fetch';
import { createStore } from './store';
import { dispatch } from './utils';

const registry: Record<string, any> = {};
const instanceMap = new WeakMap<HTMLElement, any>();

// Initializes a controller on a specific element.
function mount(el: HTMLElement) {
  const rawNames = el.dataset.gn;
  if (!rawNames) return;

  const names = rawNames.trim().split(/\s+/);
  const defs = names
    .map((name) => {
      if (!registry[name]) {
        console.warn(`[Gilligan] "${name}" not registered.`);
      }
      return registry[name];
    })
    .filter(Boolean);

  if (defs.length > 0 && !instanceMap.has(el)) {
    const finalSetup = composeSetups(defs);
    instanceMap.set(el, createController(el, finalSetup));
  }
};

function unmount(el: HTMLElement) {
  const inst = instanceMap.get(el);
  if (inst) {
    inst._unmount();
    instanceMap.delete(el);
  }
};

function register(name: string, controllerDef: any) {
  registry[name] = controllerDef;
}

function start() {
  const handleGlobalFetch = (e: Event) => {
    const target = (e.target as HTMLElement).closest<HTMLElement>('[data-gn-fetch]');
    if (target) {
      const isForm = target.tagName === 'FORM';
      if ((e.type === 'submit' && isForm) || (e.type === 'click' && !isForm)) {
        e.preventDefault();
        handleFetch(target);
      }
    }
  };
  ['click', 'submit'].forEach((evt) => document.addEventListener(evt, handleGlobalFetch));

  const observer = new MutationObserver((mutations) => {
    mutations.forEach((m) => {
      m.removedNodes.forEach((node) => {
        if (node instanceof HTMLElement) {
          if (node.dataset.gn) unmount(node);
          node.querySelectorAll<HTMLElement>('[data-gn]').forEach(unmount);
        }
      });
      m.addedNodes.forEach((node) => {
        if (node instanceof HTMLElement) {
          if (node.dataset.gn) mount(node);
          node.querySelectorAll<HTMLElement>('[data-gn]').forEach(mount);
        }
      });
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });

  const controllers = document.querySelectorAll<HTMLElement>('[data-gn]');
  if (controllers.length > 0) {
    controllers.forEach(mount);
  } else {
    console.log('[Gilligan] No controllers found.');
  }
}

// The public singleton interface. Available as 'Gilligan' and 'gn'.
export const Gilligan = {
  // State + logic
  controller,
  reactive,
  effect,
  store: createStore,
  // Events + communication
  dispatch,
  emit: internalBus.emit.bind(internalBus),
  on: internalBus.on.bind(internalBus),
  off: internalBus.off.bind(internalBus),
  // System + lifecycle
  register,
  start,
};

if (typeof window !== 'undefined') {
  (window as any).Gilligan = Gilligan;
  (window as any).gn = Gilligan;
}
