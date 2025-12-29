// Basic fetch implementation
export const handleFetch = async (el: HTMLElement) => {
  // Prioritize value in data-gx-fetch
  const url = el.dataset.gxFetch || el.getAttribute('href') || el.getAttribute('action');
  if (!url) return;

  // Prioritize value in data-gx-method
  const method = el.dataset.gxMethod || el.getAttribute('method') || 'GET';
  // If target not provided use the calling element
  const target = el.dataset.gxTarget || el;
  // Default to innerHTML
  const swapMethod = el.dataset.gxSwap || 'innerHTML';

  // Add class while loading
  // Add to target element instead or in addition to?
  el.classList.add('gx-loading');

  try {
    const options: RequestInit = {
      method: method.toUpperCase(),
      headers: { 'X-Gili-Request': 'true' },
    };

    // Serialize form data
    if (el.tagName === 'FORM') {
      options.body = new FormData(el as HTMLFormElement);
    }

    const response = await fetch(url, options);

    if (!response.ok) {
      throw new Error(`HTTP Error ${response.status}`);
    }

    // Handle standard redirects
    if (response.redirected) {
      window.location.href = response.url;
      return;
    }

    const html = await response.text();

    if (target) {
      const targetEl = typeof target === 'string' ? document.querySelector(target) : target;
      if (targetEl) {
        if (swapMethod === 'outerHTML') {
          targetEl.outerHTML = html;
        } else {
          targetEl.innerHTML = html;
        }
      }
    }
  } catch (error) {
    console.error('[Gilligan] Fetch failed:', error);
  } finally {
    el.classList.remove('gx-loading');
  }
};
