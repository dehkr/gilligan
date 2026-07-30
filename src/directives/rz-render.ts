import type { RouseApp } from '../core/app';
import { directiveSelector } from '../core/attributes';
import { warn } from '../core/diagnostics';
import { resolveBoundValue } from '../core/injection';
import { renderTemplate } from '../dom/renderer';
import type { BoundCleanupFn, BoundDirective, Scope } from '../types';
import { rzKey } from './rz-key';

/**
 * Drives an `rz-render` template: resolves its value expression reactively and
 * hands a value getter to the render engine, which reconciles instances on every
 * change. Reads the optional `rz-key` companion for explicit reconciliation keys.
 */
function bind(
  el: Element,
  scope: Scope,
  app: RouseApp,
  key: string,
  value: string,
): BoundCleanupFn | undefined {
  if (!(el instanceof HTMLTemplateElement)) {
    __DEV__ && warn(`rz-render: must be placed on a <template> element.`, el);
    return;
  }

  const raw = value || key;
  const keyPath = rzKey.getConfig(el);

  return renderTemplate(
    el,
    () => resolveBoundValue(raw, scope, app.stores, el, 'render'),
    {
      app,
      parentState: scope,
      keyPath,
    },
  ) as BoundCleanupFn;
}

export const rzRender = {
  slug: 'render',
  selector: directiveSelector('render'),
  bind,
} as const satisfies BoundDirective;
