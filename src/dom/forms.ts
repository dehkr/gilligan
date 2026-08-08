import type { RouseRequest } from '../types';

/**
 * Extracts values from standalone inputs and attaches them to the
 * request configuration (URL params for GET, body for others).
 */
export function extractFieldValues(
  el: Element,
  method: string,
  config: Partial<RouseRequest>,
): void {
  if (
    !(
      el instanceof HTMLInputElement ||
      el instanceof HTMLSelectElement ||
      el instanceof HTMLTextAreaElement
    )
  ) {
    return;
  }

  const field = el;
  if (!field.name) return;

  let values: string[] = [];

  if (field.type === 'radio') {
    // Find the checked radio in the same group (scoped to form if applicable)
    const root = field.closest('form') || document;
    const checked = root.querySelector(
      `input[type="radio"][name="${CSS.escape(field.name)}"]:checked`,
    ) as HTMLInputElement | null;

    if (checked) {
      values = [checked.value];
    }
  }

  // Checkbox
  else if (field.type === 'checkbox') {
    if ((field as HTMLInputElement).checked) {
      values = [field.value];
    }
  }

  // Multi-select
  else if (field instanceof HTMLSelectElement && field.multiple) {
    values = Array.from(field.selectedOptions).map((opt) => opt.value);
  }

  // Default
  else {
    values = [field.value];
  }

  if (values.length > 0) {
    const finalValue = values.length > 1 ? values : values[0];

    if (method === 'GET') {
      config.params = config.params || {};
      config.params[field.name] = finalValue;
    } else {
      config.body = { [field.name]: finalValue };
    }
  }
}
