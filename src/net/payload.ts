import { fail } from '../core/diagnostics';
import type { RouseRequest } from '../types';

/**
 * Prepares the URL, headers, and body for a network request.
 */
export function preparePayload(url: string, options: RouseRequest, baseUrl: string) {
  const { headers = {}, body, form, params, ...restOptions } = options;
  const method = (options.method || 'GET').toUpperCase();

  if (body != null && form != null) {
    fail(`Cannot specify both 'body' and 'form'.`, TypeError);
  }

  let urlObj: URL;

  try {
    if (isAbsoluteUrl(url)) {
      urlObj = new URL(url);
    } else {
      const base = baseUrl
        ? baseUrl.endsWith('/')
          ? baseUrl
          : `${baseUrl}/`
        : document.baseURI;
      urlObj = new URL(url, base);
    }
  } catch (err) {
    fail(`Failed to construct URL: '${url}'.`, TypeError, { cause: err });
  }

  // Append programmatic params
  if (params) {
    for (const [key, val] of Object.entries(params)) {
      if (val == null) continue;
      const values = Array.isArray(val) ? val : [val];
      for (const v of values) {
        urlObj.searchParams.append(key, String(v));
      }
    }
  }

  const reqHeaders = new Headers();
  reqHeaders.set('Rouse-Request', 'true');
  reqHeaders.set('Accept', 'application/json, text/html, image/svg+xml, */*;q=0.8');

  // To omit a header (e.g., suppressing a framework default like Rouse-Request),
  // set its value to null or undefined. An empty string is sent as an empty
  // header value. All other values, including false and 0, are sent literally.
  for (const [key, val] of Object.entries(headers)) {
    if (val == null) {
      reqHeaders.delete(key);
    } else {
      // Merge user-provided headers
      reqHeaders.set(key, String(val));
    }
  }

  // Prepare request body
  let finalBody: BodyInit | null = null;

  if (body != null) {
    // Pass through all native binary/stream BodyInit types
    if (isNativeBinaryBody(body)) {
      finalBody = body;
    }

    // URLSearchParams
    else if (body instanceof URLSearchParams) {
      finalBody = body;
      if (!reqHeaders.has('Content-Type')) {
        reqHeaders.set('Content-Type', 'application/x-www-form-urlencoded');
      }
    }

    // Plain object or array -> JSON
    else if (typeof body === 'object') {
      finalBody = JSON.stringify(body);
      if (!reqHeaders.has('Content-Type')) {
        reqHeaders.set('Content-Type', 'application/json');
      }
    }

    // String body, pass through
    else if (typeof body === 'string') {
      finalBody = body;
    }

    // Catch primitives like numbers or booleans
    // Set sensible default content-type so server knows how to parse
    else {
      finalBody = String(body);
      if (!reqHeaders.has('Content-Type')) {
        reqHeaders.set('Content-Type', 'text/plain');
      }
    }
  }

  // Fall back to form serialization if no explicit body was provided
  else if (form) {
    // GET forms should append to the URL as query parameters
    if (method === 'GET' || method === 'HEAD') {
      const formData = new FormData(form);

      for (const [key, value] of formData) {
        if (typeof value === 'string') {
          urlObj.searchParams.append(key, value);
        } else if (value instanceof File) {
          // Native HTML behavior is to send the filename in the query string
          urlObj.searchParams.append(key, value.name);
        }
      }
    }

    // POST/PUT/PATCH -> send as FormData body
    else {
      finalBody = new FormData(form);
    }
  }

  return { finalUrl: urlObj.toString(), method, reqHeaders, finalBody, restOptions };
}

/**
 * Type guard to check for native binary/stream browser BodyInit types.
 */
function isNativeBinaryBody(body: unknown): body is BodyInit {
  return (
    body instanceof FormData ||
    body instanceof Blob || // File inherits from Blob, so this catches both
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body) || // Catches DataView and TypedArray
    body instanceof ReadableStream
  );
}

function isAbsoluteUrl(url: string): boolean {
  if (/^(blob|data):/.test(url)) {
    fail(`Unsupported URL scheme: '${url}'.`, TypeError);
  }
  return /^https?:\/\//i.test(url);
}
