import { getApp, NETWORK_DIRECTIVES, type RouseApp } from '../core/app';
import { hasDirective, queryTargets } from '../core/attributes';
import { SCOPE_SELECTOR } from '../directives/rz-scope';
import { rzStore } from '../directives/rz-store';
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
  const networkDirectives = NETWORK_DIRECTIVES.map(
    (directive) => [directive, directive.selector] as const,
  );

  return new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          const addedEl = node as Element;

          const storeScriptEls = queryTargets<HTMLScriptElement>(
            addedEl,
            rzStore.selector,
          );
          for (const el of storeScriptEls) {
            if (getApp(el, app)) {
              rzStore.initialize(el, app);
            }
          }

          const scopeEls = queryTargets<HTMLElement>(addedEl, SCOPE_SELECTOR);
          for (const el of scopeEls) {
            if (getApp(el, app)) {
              initScopeElement(el, app);
            }
          }

          const ownerScope = addedEl.closest<HTMLElement>(SCOPE_SELECTOR);

          // Scan elements that belong to a scope, but make sure the element itself
          // isn't a scope. `closest` matches self, so a scope element would scan itself
          // and double-bind (`initScopeElement` already handled it above).
          if (ownerScope && !hasDirective(addedEl, 'scope') && getApp(ownerScope, app)) {
            scanScopeNode(ownerScope, addedEl);
          }

          for (const [directive, selector] of networkDirectives) {
            const networkEls = queryTargets(addedEl, selector);
            for (const el of networkEls) {
              if (getApp(el, app)) {
                directive.initialize(el, app);
              }
            }
          }

          // If the newly added element doesn't belong to a scope, walk its
          // tree and auto-mount any bound directives globally.
          if (!ownerScope) {
            walkBoundElements(addedEl, (boundEl) => {
              if (!getApp(boundEl, app)) return;
              mountGlobalBinding(boundEl, app);
            });
          }
        }
      }

      for (const node of mutation.removedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          const removedEl = node as Element;

          const storeScriptEls = queryTargets<HTMLScriptElement>(
            removedEl,
            rzStore.selector,
          );
          for (const el of storeScriptEls) {
            rzStore.teardown(el);
          }

          const scopeEls = queryTargets<HTMLElement>(removedEl, SCOPE_SELECTOR);
          for (const el of scopeEls) {
            destroyInstance(el);
          }

          // Ownership resolved against the `scopeBindings` WeakMap, not DOM
          // ancestry. Survives detached parents, cross-boundary moves, and
          // sync-detachment edge cases.
          const ownerScope = resolveRemovedOwner(removedEl);
          if (ownerScope && !hasDirective(removedEl, 'scope')) {
            teardownScopeNode(ownerScope, removedEl);
          }

          for (const [directive, selector] of networkDirectives) {
            const networkEls = queryTargets(removedEl, selector);
            for (const el of networkEls) {
              directive.teardown(el);
            }
          }

          if (!ownerScope) {
            teardownGlobalBindings(removedEl);
          }
        }
      }
    }
  });
}
