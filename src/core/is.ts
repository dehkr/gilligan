const elementMap = {
  Anchor: HTMLAnchorElement,
  Button: HTMLButtonElement,
  Form: HTMLFormElement,
  HTML: HTMLElement,
  Input: HTMLInputElement,
  Script: HTMLScriptElement,
  Select: HTMLSelectElement,
  SVG: SVGElement,
  TextArea: HTMLTextAreaElement,
} as const;

type ElementKind = keyof typeof elementMap;

export function is<K extends ElementKind>(
  el: unknown,
  kind: K,
): el is InstanceType<(typeof elementMap)[K]> {
  return el instanceof elementMap[kind];
}

export function isNativeNavigation(el: Element, e: Event): boolean {
  return (
    (e.type === 'submit' && is(el, 'Form')) || (e.type === 'click' && is(el, 'Anchor'))
  );
}
