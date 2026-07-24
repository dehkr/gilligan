import { getApp, type RouseApp } from '../core/app';
import { directiveSelector, hasDirective, queryTargets } from '../core/attributes';
import { rzFetch, rzPull, rzPush, rzStore } from '../directives';
import {
  mountGlobalBinding,
  resolveRemovedOwner,
  teardownGlobalBindings,
  walkBoundElements,
} from './binder';
import {
  destroyInstance,
  initScopeElement,
  scanScopeNode,
  teardownScopeNode,
} from './scope';

/**
 * Creates a `MutationObserver` scoped to the provided app instance. Initializes
 * stores, scopes, network directives, and bound directives on added subtrees,
 * and runs the matching teardown on removed ones.
 *
 * @returns A configured, unstarted MutationObserver instance.
 */
export function initObserver(app: RouseApp) {
  const scopeSelector = directiveSelector('scope');
  const storeSelector = `script${directiveSelector('store')}`;
  const networkDirectives = [rzFetch, rzPush, rzPull].map(
    (directive) => [directive, directiveSelector(directive.slug)] as const,
  );

  return new MutationObserver((mutations) => {
    mutations.forEach((m) => {
      m.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) {
          const el = node as Element;

          queryTargets(el, storeSelector).forEach((el) => {
            if (rzStore.validate(el, app)) {
              rzStore.initialize(el, app);
            }
          });

          queryTargets<HTMLElement>(el, scopeSelector).forEach((el) => {
            // Confirm app ownership in case of nested apps
            if (getApp(el, app)) {
              initScopeElement(el, app);
            }
          });

          const ownerScope = el.closest<HTMLElement>(scopeSelector);

          // Scan elements that belong to a scope, but make sure the element itself
          // isn't a scope. `closest` matches self, so a scope element would scan itself
          // and double-bind (`initScopeElement` already handled it above).
          if (ownerScope && !hasDirective(el, 'scope') && getApp(ownerScope, app)) {
            scanScopeNode(ownerScope, el);
          }

          for (const [directive, selector] of networkDirectives) {
            queryTargets(el, selector).forEach((el) => {
              if (getApp(el, app)) {
                directive.initialize(el, app);
              }
            });
          }

          // If the newly added element doesn't belong to a scope, walk its
          // tree and auto-mount any bound directives globally.
          if (!ownerScope) {
            walkBoundElements(el, (boundEl) => {
              if (!getApp(boundEl, app)) return;
              mountGlobalBinding(boundEl, app);
            });
          }
        }
      });

      m.removedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) {
          const el = node as Element;

          queryTargets<HTMLScriptElement>(el, storeSelector).forEach((el) => {
            rzStore.teardown(el);
          });

          queryTargets<HTMLElement>(el, scopeSelector).forEach(destroyInstance);

          // Ownership resolved against the `scopeBindings` WeakMap, not DOM
          // ancestry. Survives detached parents, cross-boundary moves, and
          // sync-detachment edge cases.
          const ownerScope = resolveRemovedOwner(el);
          if (ownerScope && !hasDirective(el, 'scope')) {
            teardownScopeNode(ownerScope, el);
          }

          for (const [directive, selector] of networkDirectives) {
            queryTargets<HTMLElement>(el, selector).forEach(directive.teardown);
          }

          if (!ownerScope) {
            teardownGlobalBindings(el);
          }
        }
      });
    });
  });
}
