// Helper to parse JSON from string or script ID
export function safeParse(input: string | undefined) {
  if (!input) {
    return {};
  }

  if (input.startsWith('#')) {
    const el = document.querySelector(input);
    if (el) {
      try {
        return JSON.parse(el.textContent || '{}');
      } catch (e) {
        console.warn(`[Gilligan] Failed to parse JSON from ${input}:`, e);
        return {};
      }
    }
  }

  try {
    return JSON.parse(input);
  } catch {
    return {};
  }
}
