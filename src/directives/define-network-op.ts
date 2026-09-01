import type { RouseApp } from '../core/app';
import { directiveSelector, getDirectiveValue } from '../core/attributes';
import { warn } from '../core/diagnostics';
import { parseTriggerSubjectPairs } from '../core/parser';
import type {
  DirectiveSlug,
  StandaloneDirective,
  TriggerSubjectPair,
  VoidFn,
} from '../types';

/**
 * Factory for the network directives (rz-fetch, rz-push, rz-pull), which share
 * the `[trigger]: [subject]` grammar. Owns the per-element cleanup registry and
 * the shared initialize/teardown scaffolding.
 *
 * @param bindPairs - Wires the parsed pairs for one element and returns their cleanups.
 */
export function defineNetworkOpDirective(
  slug: Extract<DirectiveSlug, 'fetch' | 'push' | 'pull'>,
  bindPairs: (el: Element, app: RouseApp, pairs: TriggerSubjectPair[]) => VoidFn[],
): StandaloneDirective {
  const elementCleanups = new WeakMap<Element, VoidFn[]>();

  return {
    selector: directiveSelector(slug),
    initialize(el: Element, app: RouseApp) {
      if (elementCleanups.has(el)) return;

      const value = getDirectiveValue(el, slug);
      if (value === null) return;

      const pairs = parseTriggerSubjectPairs(value);
      if (pairs.length === 0) {
        __DEV__ && warn(`rz-${slug}: at least one trigger is required.`, el);
        return;
      }

      const cleanups = bindPairs(el, app, pairs);
      if (cleanups.length > 0) {
        elementCleanups.set(el, cleanups);
      }
    },
    teardown(el: Element) {
      elementCleanups.get(el)?.forEach((fn) => fn());
      elementCleanups.delete(el);
    },
  };
}
