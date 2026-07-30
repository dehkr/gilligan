import type { DirectiveSlug } from '../types';

/**
 * Generates a CSS selector matching both prefix styles (`[rz-text], [data-rz-text]`).
 * Pass `tag` to qualify both entries; prefixing the returned string yourself
 * qualifies only the first.
 */
export function directiveSelector(slug: DirectiveSlug, tag = ''): string {
  return `${tag}[rz-${slug}], ${tag}[data-rz-${slug}]`;
}

/**
 * Gets the directive value associated with a specific element. Returns `null` if
 * the directive isn't present.
 */
export function getDirectiveValue(el: Element, slug: DirectiveSlug): string | null {
  return el.getAttribute(`rz-${slug}`) ?? el.getAttribute(`data-rz-${slug}`);
}

/**
 * Checks if the element has a specific directive.
 */
export function hasDirective(el: Element, slug: DirectiveSlug): boolean {
  return el.hasAttribute(`rz-${slug}`) || el.hasAttribute(`data-rz-${slug}`);
}

/**
 * Queries within the element boundary, including the element itself. Returns an
 * empty array for an invalid selector rather than throwing.
 */
export function queryTargets<T extends Element = Element>(
  el: Element,
  selector: string,
): T[] {
  try {
    const targets = Array.from(el.querySelectorAll<T>(selector));
    if (el.matches(selector)) {
      targets.unshift(el as T);
    }
    return targets;
  } catch {
    return [];
  }
}
