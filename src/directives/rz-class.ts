import { effect } from 'alien-signals';
import type { RouseApp } from '../core/app';
import { directiveSelector } from '../core/attributes';
import { resolveBoundValue } from '../core/invoke';
import { updateClass } from '../dom/updater';
import type { BoundCleanupFn, BoundDirective, Scope } from '../types';

function bind(
  el: Element,
  scope: Scope,
  app: RouseApp,
  key: string,
  val: string,
): BoundCleanupFn {
  return effect(() => {
    const resolvedValue = resolveBoundValue(val || key, scope, app.stores, el, 'class');
    updateClass(el, val === '' ? resolvedValue : { [key]: !!resolvedValue });
  }) as BoundCleanupFn;
}

export const rzClass = {
  slug: 'class',
  selector: directiveSelector('class'),
  bind,
} as const satisfies BoundDirective;
