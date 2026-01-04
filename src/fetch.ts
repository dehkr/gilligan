/**
 * Basic fetch handling.
 * Swaps HTML content from a server response without a full page reload.
 * Triggered by 'data-gn-fetch' on links, forms, or buttons.
 */
export const handleFetch = async (el: HTMLElement) => {
  // Prioritize value in data-gn-fetch
  const url = el.dataset.gnFetch || el.getAttribute('href') || el.getAttribute('action');
  if (!url) return;

  // Prioritize value in data-gn-method
  const method = el.dataset.gnMethod || el.getAttribute('method') || 'GET';
  // If target not provided use the calling element
  const target = el.dataset.gnTarget || el;
  // Default to innerHTML
  const swapMethod = el.dataset.gnSwap || 'outerHTML';

  // Add class while loading
  // TODO: Add to target element instead or in addition to?
  el.classList.add('gn-loading');
  el.setAttribute('aria-busy', 'true');

  try {
    const options: RequestInit = {
      method: method.toUpperCase(),
      headers: { 'Gilligan-Request': 'true' },
    };

    // Serialize form data
    if (el.tagName === 'FORM') {
      options.body = new FormData(el as HTMLFormElement);
    }

    const response = await fetch(url, options);

    if (!response.ok) {
      throw new Error(`[Gilligan] Fetch failed: ${response.status}`);
    }

    const html = await response.text();

    if (target) {
      const targetEl = typeof target === 'string' ? document.querySelector(target) : target;
      if (targetEl) {
        if (swapMethod === 'outerHTML') {
          targetEl.outerHTML = html;
        } else if (swapMethod === 'innerHTML') {
          targetEl.innerHTML = html;
        } else if (swapMethod === 'beforebegin') {
          targetEl.insertAdjacentHTML('beforebegin', html);
        } else if (swapMethod === 'afterbegin') {
          targetEl.insertAdjacentHTML('afterbegin', html);
        } else if (swapMethod === 'beforeend') {
          targetEl.insertAdjacentHTML('beforeend', html);
        } else if (swapMethod === 'afterend') {
          targetEl.insertAdjacentHTML('afterend', html);
        }
      }
    }
  } catch (error) {
    console.error('[Gilligan] Fetch failed:', error);
  } finally {
    el.classList.remove('gn-loading');
    el.setAttribute('aria-busy', 'false');
  }
};
