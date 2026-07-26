import { effect } from 'alien-signals';
import type { RouseApp } from '../core/app';
import { warn } from '../core/diagnostics';
import { is } from '../core/is';
import { parseTriggers } from '../core/parser';
import { resolveState, writeState } from '../core/resolve';
import { dispatchTrigger } from '../dom/events';
import { getModelableValue, setModelableValue } from '../dom/updater';
import type {
  BindableValue,
  BoundCleanupFn,
  BoundDirective,
  Scope,
  TriggerDef,
} from '../types';

/**
 * Returns the default trigger for a given element. Custom elements and
 * anything without a known default return `null`.
 */
function modelDefaultTrigger(el: Element): TriggerDef | null {
  const def = (event: string) => ({ event, modifiers: [] });

  if (is(el, 'TextArea') || (el as HTMLElement).isContentEditable) {
    return def('input');
  }
  if (is(el, 'Input')) {
    return el.type === 'checkbox' || el.type === 'radio' ? def('change') : def('input');
  }
  if (is(el, 'Select')) {
    return def('change');
  }

  return null;
}

/**
 * Wires two-way binding on an editable element: an effect writes resolved state
 * into the element, and each trigger writes the element's value back. A bare
 * subject (no `trigger: subject` pair) infers its trigger via `modelDefaultTrigger`,
 * and binds nothing when the element has no default.
 */
function bind(
  el: Element,
  scope: Scope,
  app: RouseApp,
  key: string,
  value: string,
): BoundCleanupFn | undefined {
  const subject = value || key;

  let triggers: TriggerDef[];
  if (value) {
    triggers = parseTriggers(key);
  } else {
    const def = modelDefaultTrigger(el);
    if (!def) {
      __DEV__ &&
        warn(
          `rz-model: an explicit trigger is required when used on <${el.tagName.toLowerCase()}> (e.g., rz-model="input: value").`,
          el,
        );
      return;
    }
    triggers = [def];
  }

  const cleanups = [
    effect(() => {
      // State -> DOM
      setModelableValue(el, resolveState<BindableValue>(subject, scope, app.stores));
    }),
  ];

  // DOM -> State
  const action = () => writeState(subject, getModelableValue(el), scope, app.stores);

  for (const trigger of triggers) {
    const cleanup = dispatchTrigger(trigger, { el, app, action });
    if (cleanup) {
      cleanups.push(cleanup);
    }
  }

  return (() => cleanups.forEach((fn) => fn())) as BoundCleanupFn;
}

export const rzModel = {
  slug: 'model',
  bind,
} as const satisfies BoundDirective;
