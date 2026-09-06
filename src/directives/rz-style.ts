import { effect } from 'alien-signals';
import type { RouseApp } from '../core/app';
import { directiveSelector } from '../core/attributes';
import { resolveBoundValue } from '../core/invoke';
import { applyStyles, setStyleProperty, updateStyle } from '../dom/updater';
import type { BoundCleanupFn, BoundDirective, Scope } from '../types';

function bind(
  el: Element,
  scope: Scope,
  app: RouseApp,
  key: string,
  val: string,
): BoundCleanupFn {
  return effect(() => {
    const lookup = val === '' ? key : val;
    const resolved = resolveBoundValue(lookup, scope, app.stores, el, 'style');

    if (val === '') {
      updateStyle(el, resolved);
    } else if (key.includes(':')) {
      applyStyles(el, key, !!resolved);
    } else {
      setStyleProperty(el, key, resolved);
    }
  }) as BoundCleanupFn;
}

export const rzStyle = {
  slug: 'style',
  selector: directiveSelector('style'),
  bind,
} as const satisfies BoundDirective;
