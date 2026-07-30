import { effect } from 'alien-signals';
import type { RouseApp } from '../core/app';
import { directiveSelector } from '../core/attributes';
import { resolveBoundValue } from '../core/injection';
import {
  updateAttr,
  updateClass,
  updateHtml,
  updateProp,
  updateStyle,
  updateText,
} from '../dom/updater';
import type {
  BindableValue,
  BoundCleanupFn,
  BoundDirective,
  DirectiveSlug,
  Scope,
} from '../types';

/**
 * Factory for the bound-writer directives (rz-attr, rz-text, rz-html, rz-prop).
 * Resolves a bound value inside an effect and writes it to the element.
 */
function defineBoundWriterDirective(
  slug: DirectiveSlug,
  write: (el: Element, key: string, val: BindableValue) => void,
): BoundDirective {
  return {
    slug,
    selector: directiveSelector(slug),
    bind(
      el: Element,
      scope: Scope,
      app: RouseApp,
      key: string,
      value: string,
    ): BoundCleanupFn {
      const raw = value || key;
      return effect(() => {
        write(el, key, resolveBoundValue(raw, scope, app.stores, el, slug));
      }) as BoundCleanupFn;
    },
  };
}

export const rzText = defineBoundWriterDirective('text', (el, _key, val) =>
  updateText(el, val),
);
export const rzHtml = defineBoundWriterDirective('html', (el, _key, val) =>
  updateHtml(el, val),
);
export const rzProp = defineBoundWriterDirective('prop', (el, key, val) =>
  updateProp(el, key, val),
);
export const rzAttr = defineBoundWriterDirective('attr', (el, key, val) => {
  if (key === 'class') {
    updateClass(el, val);
  } else if (key === 'style') {
    updateStyle(el, val);
  } else {
    updateAttr(el, key, val);
  }
});
