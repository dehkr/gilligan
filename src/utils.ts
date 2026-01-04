/**
 * Dispatches a custom event from a specific element.
 *
 * @param el - The element to dispatch from
 * @param name - The event name
 * @param detail - The event data
 */
export function dispatch(el: HTMLElement, name: string, detail: any = {}) {
  const event = new CustomEvent(name, { detail, bubbles: true, cancelable: true });
  el.dispatchEvent(event);
  return event;
}

/**
 * Safely parses JSON from a string or a DOM element reference.
 *
 * @param input - JSON string or id of script element containing JSON (e.g. "#app-data")
 */
export function safeParse(input: string | undefined | null): any {
  if (!input) return {};

  const value = input.trim();
  if (!value) return {};

  if (value.startsWith('#')) {
    try {
      const el = document.querySelector(value);
      if (el) {
        const jsonContent = (el.textContent || '').trim();
        return jsonContent ? JSON.parse(jsonContent) : {};
      } else {
        console.warn(`[Gilligan] Config element not found: "${value}"`);
        return {};
      }
    } catch (e) {
      console.warn(`[Gilligan] Error parsing config from "${value}":`, e);
      return {};
    }
  }

  try {
    return JSON.parse(value);
  } catch (e) {
    console.warn(`[Gilligan] Failed to parse JSON attribute:`, e);
    return {};
  }
}

/**
 * Checks if a value is an object and not null.
 */
export function isObject(val: unknown): val is object {
  return val !== null && typeof val === 'object';
}
