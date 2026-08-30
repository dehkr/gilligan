import type {
  DirectiveSlug,
  TriggerDef,
  TriggerOptions,
  TriggerSubjectPair,
} from '../types';
import {
  type HttpMethod,
  isFlagModifier,
  isHttpMethod,
  isListenTarget,
  KEY_BLOCKLIST,
} from './constants';
import { warn } from './diagnostics';
import { isTimeModifier } from './timing';

const closers = { ')': '(', '}': '{', ']': '[' } as const;
const openers = new Set<string>(Object.values(closers));

type ParsedDirectiveValue = Array<[string, string | null]>;
type BoundaryCloser = keyof typeof closers;
type BoundaryOpener = (typeof closers)[BoundaryCloser];

const isCloser = (char: string): char is BoundaryCloser => Object.hasOwn(closers, char);
const isOpener = (char: string): char is BoundaryOpener => openers.has(char);

/**
 * Splits a directive value into `[key, value]` pairs. Pairs are separated by ', '
 * (comma + whitespace); within a pair, the first ': ' separates key from value.
 * A bare key parses with a `null` value; a trailing colon warns and skips the
 * segment. Quotes and bracket boundaries are respected throughout.
 *
 * When a pair has a `null` value, the consumer decides how to read the bare key.
 * It could be treated as a flag, or as the meaningful value itself (as in the
 * `rz-target` selector example here).
 *
 * @example
 * parseDirectiveValue('beforeend: #item-list, #log > div.output');
 * // [
 * //   ['beforeend', '#item-list'],
 * //   ['#log > div.output', null],
 * // ]
 */
export function parseDirectiveValue(
  value: string | null | undefined,
): ParsedDirectiveValue {
  let cleanedValue = value?.trim();
  if (!cleanedValue) return [];

  // Strip trailing commas to allow for multi-line HTML formatting
  if (cleanedValue.endsWith(',')) {
    cleanedValue = cleanedValue.slice(0, -1).trim();
  }

  const parsed: ParsedDirectiveValue = [];
  let start = 0;

  // Scan for values separated by comma + space
  const scanResult = forEachSafeChar(cleanedValue, (i, char) => {
    if (char === ',' && hasTrailingWhitespace(cleanedValue, i)) {
      parseSegment(cleanedValue.slice(start, i), parsed);
      start = i + 1;
    }
    // Keep scanning
    return false;
  });

  __DEV__ &&
    !scanResult.mismatched &&
    (scanResult.depth > 0 || scanResult.quote) &&
    warn(`Malformed directive value: '${value}'.`);

  // Final segment
  parseSegment(cleanedValue.slice(start), parsed);

  return parsed;
}

/**
 * Parses one segment into a `[key, value]` pair and appends it to `pairs`. A bare
 * key appends with a `null` value. A trailing colon warns and appends nothing.
 */
function parseSegment(segment: string, pairs: ParsedDirectiveValue): void {
  const trimmed = segment.trim();
  if (!trimmed) return;

  let splitIndex = -1;

  forEachSafeChar(trimmed, (i, char, text) => {
    // Colon + whitespace separates the `'key: value'` of a segment
    if (char === ':' && hasTrailingWhitespace(text, i)) {
      splitIndex = i;
      // Stop at first valid separator
      return true;
    }
    // Otherwise keep scanning
    return false;
  });

  if (splitIndex !== -1) {
    const key = stripQuotes(trimmed.slice(0, splitIndex).trim());
    const val = stripQuotes(trimmed.slice(splitIndex + 1).trim());
    if (key) {
      pairs.push([key, val]);
    }
  } else if (trimmed.endsWith(':')) {
    // A trailing ':' most likely means a value was inadvertently left out
    __DEV__ && warn(`Ignoring '${trimmed}': trailing colon has no value.`);
  } else {
    const key = stripQuotes(trimmed);
    if (key) {
      pairs.push([key, null]);
    }
  }
}

/**
 * Splits a directive value into trigger/subject pairs. Comma-separated groups
 * pair space-separated triggers with one shared subject after the colon. A group
 * with no colon yields a `null` subject, leaving the directive to resolve the
 * URL/target from the element.
 *
 * @example
 * parseTriggerSubjectPairs('input|debounce change: /api/users');
 * // [
 * //   {
 * //     trigger: { event: 'input', options: { debounce: true } },
 * //     subject: '/api/users',
 * //   },
 * //   {
 * //     trigger: { event: 'change', options: {} },
 * //     subject: '/api/users',
 * //   },
 * // ]
 */
export function parseTriggerSubjectPairs(
  value: string | null | undefined,
): TriggerSubjectPair[] {
  return parseDirectiveValue(value).flatMap(([keyStr, subjectStr]) => {
    const subject = subjectStr || null;
    return parseTriggers(keyStr).map((trigger) => ({ trigger, subject }));
  });
}

/**
 * Splits a `name-[attribute]` token into its name and trimmed attribute, or
 * `null` when the token carries no attribute.
 */
function parseAttrToken(token: string): [name: string, attr: string] | null {
  if (!token.endsWith(']')) return null;

  const open = token.indexOf('-[');
  return open > 0 ? [token.slice(0, open), token.slice(open + 2, -1).trim()] : null;
}

/**
 * Resolves dot-separated modifier tokens into `TriggerOptions`. A bare token is a
 * flag (`once`) or a listener target (`window`); a `name-[attribute]` token binds
 * a value to that modifier (`debounce-[300ms]`, `key-[enter]`); a bare time or
 * `(query)` value is an argument to the event (`interval|30s`).
 */
function normalizeModifiers(tokens: string[], trigger: string): TriggerOptions {
  const options: TriggerOptions = {};
  const keys: string[] = [];

  for (const token of tokens) {
    const attrToken = parseAttrToken(token);

    if (attrToken) {
      const [name, attr] = attrToken;

      if (!attr) {
        __DEV__ && warn(`Empty attribute on modifier '${name}' in trigger '${trigger}'.`);
        continue;
      }

      if (name === 'key') {
        const key = attr.toLowerCase();
        keys.push(key === 'space' ? ' ' : key);
      } else if (name === 'debounce' || name === 'throttle') {
        options[name] = attr;
      } else {
        __DEV__ && warn(`Unknown modifier '${name}' in trigger '${trigger}'.`);
      }

      continue;
    }

    if (isFlagModifier(token)) {
      options[token === 'stop-immediate' ? 'stopImmediate' : token] = true;
    } else if (isListenTarget(token)) {
      options.listenOn = token;
    } else if (token === 'debounce' || token === 'throttle') {
      options[token] = true;
    } else if (isTimeModifier(token)) {
      options.wait = token;
    } else if (token.startsWith('(') && token.endsWith(')')) {
      options.query = token;
    } else {
      __DEV__ && warn(`Unknown modifier '${token}' in trigger '${trigger}'.`);
    }
  }

  if (keys.length > 0) {
    options.key = keys;
  }

  return options;
}

/**
 * Parses a raw trigger string into trigger definitions, splitting on whitespace
 * outside quotes and boundaries. Top-level commas are rejected; multi-trigger
 * values are space-separated.
 *
 * @example
 * parseTriggers('click|throttle-[300ms] mouseenter|once mouseleave');
 * // [
 * //   { event: 'click', options: { throttle: '300ms' } },
 * //   { event: 'mouseenter', options: { once: true } },
 * //   { event: 'mouseleave', options: {} },
 * // ]
 */
export function parseTriggers(value: string | null | undefined): TriggerDef[] {
  let raw = value?.trim();
  if (!raw) return [];

  raw = stripQuotes(raw);

  // A comma inside a bracketed attribute is data, not a separator: `key-[,]`
  if (splitOnSafeDelimiter(raw, ',').length > 1) {
    __DEV__ && warn(`Separate multi-trigger values by spaces, not commas: '${raw}'.`);
    return [];
  }

  const triggers = splitOnSafeDelimiter(raw, (char) => /\s/.test(char));
  const parsed: TriggerDef[] = [];

  // A single '|' separates the event from its modifiers, which are then dot-separated.
  // Both splits ignore delimiters inside quotes or boundaries.
  for (const trigger of triggers) {
    if (!trigger) continue;

    const [event = '', modifierGroup, ...extraGroups] = splitOnSafeDelimiter(
      trigger,
      '|',
    );

    if (!event || modifierGroup === '' || extraGroups.length > 0) {
      __DEV__ &&
        warn(
          `Malformed trigger: '${trigger}'. Use a single '|' after the event, followed by dot-separated modifiers.`,
        );
      continue;
    }

    const modifiers = modifierGroup
      ? splitOnSafeDelimiter(modifierGroup, '.').filter(Boolean)
      : [];

    parsed.push({ event, options: normalizeModifiers(modifiers, trigger) });
  }

  return parsed;
}

/**
 * Parses a fetch subject string into an optional HTTP method and/or a URL.
 * The method is matched by vocabulary. Either may be omitted (a missing URL
 * is resolved from the element).
 *
 * @example
 * parseFetchSubject('POST /api/users'); // { method: 'POST', url: '/api/users' }
 * parseFetchSubject('/api/users');      // { url: '/api/users' }
 * parseFetchSubject('DELETE');          // { method: 'DELETE' }
 */
export function parseFetchSubject(subject: string): {
  method?: HttpMethod;
  url?: string;
} {
  const ws = subject.search(/\s/);
  const head = ws === -1 ? subject : subject.slice(0, ws);

  // A leading HTTP method is split off. The rest is the URL. If a leading
  // HTTP method isn't detected, treat the entire string as the URL.
  if (isHttpMethod(head)) {
    return {
      method: head.toUpperCase() as HttpMethod,
      url: ws === -1 ? undefined : subject.slice(ws + 1).trim(),
    };
  }

  return { url: subject };
}

/**
 * Parses a prefixed data-source path into the source it names, the `::`
 * namespace it addresses (if any), and the nested dot-path into whichever of
 * the two. Shared by `@` store references and `#` script-id references.
 *
 * @example
 * parseDataSourcePath('@cart.items.total');
 * // { source: 'cart', namespace: null, nestedPath: 'items.total' }
 *
 * parseDataSourcePath('@cart::status.loading');
 * // { source: 'cart', namespace: 'status', nestedPath: 'loading' }
 *
 * parseDataSourcePath('#config.theme');
 * // { source: 'config', namespace: null, nestedPath: 'theme' }
 */
export function parseDataSourcePath(value: string): {
  source: string;
  namespace: string | null;
  nestedPath: string;
} {
  const path = value.slice(1);

  // `parseSegment` splits a `key: value` pair only on a colon followed by
  // whitespace, so `::` is safe as a namespace operator.
  const nsIndex = path.indexOf('::');

  if (nsIndex !== -1) {
    const rest = path.slice(nsIndex + 2);
    const dot = rest.indexOf('.');
    return {
      source: path.slice(0, nsIndex),
      namespace: dot === -1 ? rest : rest.slice(0, dot),
      nestedPath: dot === -1 ? '' : rest.slice(dot + 1),
    };
  }

  const dotIndex = path.indexOf('.');

  if (dotIndex === -1) {
    return { source: path, namespace: null, nestedPath: '' };
  }

  return {
    source: path.slice(0, dotIndex),
    namespace: null,
    nestedPath: path.slice(dotIndex + 1),
  };
}

/**
 * Parses a store reference at a site where only store data is valid. Warns and
 * returns `null` when the reference names a namespace (`@cart::status`).
 */
export function parseStoreRef(
  ref: string,
  slug?: DirectiveSlug,
): { source: string; nestedPath: string } | null {
  const { source, namespace, nestedPath } = parseDataSourcePath(ref);

  if (namespace) {
    __DEV__ &&
      warn(
        `${slug ? `rz-${slug}: ` : ''}'${ref}' references the '${namespace}' namespace. Use '@${source}' to reference store data.`,
      );
    return null;
  }

  return { source, nestedPath };
}

/**
 * Parses a CSS declaration string into `[property, value]` pairs.
 *
 * @example
 * parseDeclarations('color: red; margin: 0 auto');
 * // [
 * //   ['color', 'red'],
 * //   ['margin', '0 auto'],
 * // ]
 */
export function parseDeclarations(decl: string): Array<[string, string]> {
  return splitOnSafeDelimiter(decl, ';')
    .map((d) => {
      const [prop = '', ...rest] = splitOnSafeDelimiter(d, ':');
      return [prop.trim(), rest.join(':').trim()] as [string, string];
    })
    .filter(([prop]) => prop);
}

/**
 * Splits `text` on every occurrence of `delimiter` outside quotes and bracket boundaries,
 * returning the resulting segments. Empty segments are preserved, so callers can
 * distinguish a missing part from an absent one; filter where they're noise.
 *
 * Centralises the start-pointer / slice / remainder pattern that would otherwise
 * be repeated across every parsing function.
 */
function splitOnSafeDelimiter(
  text: string,
  delimiter: string | ((char: string) => boolean),
): string[] {
  const isDelimiter =
    typeof delimiter === 'string' ? (c: string) => c === delimiter : delimiter;

  const parts: string[] = [];
  let start = 0;

  forEachSafeChar(text, (i, char) => {
    if (isDelimiter(char)) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
    return false;
  });

  parts.push(text.slice(start));
  return parts;
}

/**
 * Parse JSON with recursive check that blocks prototype pollution keys.
 */
export function safeJSONParse(text: string): unknown {
  return JSON.parse(text, (key, value) => {
    if (KEY_BLOCKLIST.includes(key)) {
      __DEV__ && warn(`Blocked forbidden key in JSON: '${key}'.`);
      return undefined;
    }
    return value;
  });
}

/**
 * Iterates through text and fires a callback for each top-level character that
 * isn't a quote or bracket.
 *
 * Returns the final scan state, which can be used to detect malformed input
 * (e.g. unclosed brackets or quotes).
 *
 * Per-type depth counters are maintained to catch mismatched bracket pairs
 * such as `(]`. A mismatch is warned and the closer is ignored.
 */
function forEachSafeChar(
  text: string,
  callback: (index: number, char: string, fullText: string) => boolean | undefined,
): {
  depth: number;
  quote: string | null;
  mismatched: boolean;
} {
  const depths: Record<BoundaryOpener, number> = { '(': 0, '{': 0, '[': 0 };
  let totalDepth = 0;
  let quote: string | null = null;
  let mismatched = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i] as string;
    const prev = text[i - 1];

    // Inside a quote: look for the unescaped closing quote
    if (quote) {
      if (char === quote && prev !== '\\') {
        quote = null;
      }
    }

    // Entering a new quote
    else if (char === "'" || char === '"') {
      quote = char;
    }

    // Entering a nested block (increment depth)
    else if (isOpener(char)) {
      depths[char]++;
      totalDepth++;
    }

    // Exiting a block (decrement depth and validate matching pairs)
    else if (isCloser(char)) {
      const opener = closers[char];
      if (depths[opener] > 0) {
        depths[opener]--;
        totalDepth--;
      } else {
        mismatched = true;
        __DEV__ && warn(`Mismatched bracket '${char}' in value: '${text}'.`);
      }
    }

    // Safe top-level character: trigger the callback
    else if (totalDepth === 0) {
      if (callback(i, char, text)) {
        return { depth: totalDepth, quote, mismatched };
      }
    }
  }

  return { depth: totalDepth, quote, mismatched };
}

/**
 * Checks if a string is enclosed in matching quotation marks.
 */
function isInQuotes(val: string) {
  if (val.length < 2) return false;
  const first = val[0];
  const last = val[val.length - 1];

  return (first === '"' || first === "'") && first === last;
}

/**
 * Strips matching outer quotes from a string and trims the result.
 */
function stripQuotes(val: string) {
  if (isInQuotes(val)) {
    return val.slice(1, -1).trim();
  }
  return val;
}

/**
 * Checks if a specific character index in a string is followed by whitespace.
 */
function hasTrailingWhitespace(text: string, index: number) {
  return index + 1 < text.length && /\s/.test(text.charAt(index + 1));
}
