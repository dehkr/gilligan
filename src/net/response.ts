import type {
  CustomErrorStatus,
  ErrorStatus,
  FetchRequest,
  RequestError,
  RouseResponse,
} from '../types';

/**
 * Normalizes a fetch response (parses JSON/Text/Blob and flags HTTP errors).
 */
export async function normalizeResponse(
  response: Response,
  config: FetchRequest,
): Promise<RouseResponse> {
  let data: any = null;
  let error: RequestError | null = null;

  const parsedHeaders = Object.fromEntries(response.headers.entries());

  try {
    // Safety check to make sure the body hasn't been consumed.
    if (response.bodyUsed) {
      return {
        data: null,
        error: { message: 'Stream already consumed', status: 'INTERNAL_ERROR' },
        response,
        headers: parsedHeaders,
        status: response.status,
        config,
      };
    }

    const contentType = response.headers.get('Content-Type') || '';
    const contentLength = response.headers.get('Content-Length');
    const isEmpty =
      response.status === 204 || response.status === 205 || contentLength === '0';

    if (!isEmpty) {
      // Bail on streams to avoid the request getting hung up forever
      if (contentType.includes('text/event-stream')) {
        response.body?.cancel();
        error = {
          message: 'Cannot read an event stream as a response. Open it with rz-sse.',
          status: 'PARSE_ERROR',
        };
      } else if (isJsonType(contentType)) {
        const text = await response.text();
        // A malformed body throws a native SyntaxError, caught below as PARSE_ERROR
        if (text) {
          data = JSON.parse(text);
        }
      } else if (contentType.includes('text/') || contentType.includes('xml')) {
        data = await response.text();
      } else {
        data = await response.blob();
      }
    }
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e);
    data = null;
    error = { message: errorMessage, status: 'PARSE_ERROR' };
  }

  // HTTP errors (4xx/5xx) overwrite PARSE_ERRORs here,
  // because bad JSON is usually a symptom of a server crash.
  if (!response.ok) {
    error = {
      message: response.statusText || 'Request failed',
      status: response.status,
      body: data ?? undefined,
      parseError: error?.status === 'PARSE_ERROR' ? error.message : undefined,
    };
  }

  return {
    data,
    error,
    response,
    headers: parsedHeaders,
    status: response.status,
    config,
  };
}

/**
 * Maps native DOM exceptions into standardized `RequestError` objects.
 *
 * **Note:** If a global timeout and a manual abort happen simultaneously, the
 * manual abort (`isMainAborted`) wins out and the status is set to 'CANCELED'.
 */
export function mapCatchError(error: any, isMainAborted: boolean): RequestError {
  const isAbort = error.name === 'AbortError';
  const isTimeout = error.name === 'TimeoutError';

  // Distinguish between timeout and explicit cancel
  const status: CustomErrorStatus = isTimeout
    ? 'TIMEOUT'
    : isAbort
      ? isMainAborted
        ? 'CANCELED'
        : 'TIMEOUT'
      : 'NETWORK_ERROR';

  const message =
    status === 'TIMEOUT'
      ? 'Request timed out'
      : status === 'CANCELED'
        ? 'Request canceled'
        : error.message || 'Network error';

  return { message, status, original: error };
}

/**
 * Helper to return a structured response for early bailouts.
 */
export function fallbackResponse(
  config: FetchRequest,
  message: string,
  status: ErrorStatus = 'CANCELED',
): RouseResponse {
  return {
    data: null,
    error: { message, status },
    response: null,
    headers: null,
    status: null,
    config,
  };
}

export function isJsonType(val: string) {
  return val.includes('application/json') || val.includes('+json');
}

export function isFileType(data: unknown) {
  return data instanceof Blob || data instanceof ArrayBuffer;
}
