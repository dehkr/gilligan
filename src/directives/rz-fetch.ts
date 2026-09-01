import type { RouseApp } from '../core/app';
import { warn } from '../core/diagnostics';
import { parseFetchSubject } from '../core/parser';
import { dispatchTrigger, isNativeNavigation } from '../dom/events';
import { runFetch } from '../net/fetch-engine';
import type { FetchRequest, TriggerSubjectPair, VoidFn } from '../types';
import { defineNetworkOpDirective } from './define-network-op';

/**
 * Returns the URL value if it exists from an anchor element's `href` or
 * a form element's `action` attribute.
 */
function nativeUrl(el: Element): string {
  if (el instanceof HTMLAnchorElement) {
    return el.getAttribute('href') ?? '';
  }
  if (el instanceof HTMLFormElement) {
    return el.getAttribute('action') ?? '';
  }
  return '';
}

/**
 * Extracts `formaction` and `formmethod` from the button that triggered a
 * submit event to override the form's default request configuration.
 */
function applySubmitterOverrides(baseOpts: FetchRequest, e?: Event): FetchRequest {
  const opts: FetchRequest = { ...baseOpts };
  const sub = e instanceof SubmitEvent ? e.submitter : null;

  if (sub) {
    opts.url = sub.getAttribute('formaction') ?? opts.url;
    opts.method = sub.getAttribute('formmethod')?.toUpperCase() ?? opts.method;
  }

  return opts;
}

/**
 * Binds each `[trigger]: [[METHOD] URL]` pair to a fetch. Resolves the URL once
 * and shares it across the element's triggers. Returns the pairs' cleanups.
 */
function bindFetchPairs(el: Element, app: RouseApp, pairs: TriggerSubjectPair[]) {
  const cleanups: VoidFn[] = [];
  const elementUrl = nativeUrl(el);

  // A form without a URL at init can still get one at submit time from the
  // submitter's `formaction`, so bind anyway and validate on dispatch.
  const deferUrl = el instanceof HTMLFormElement;

  // The URL is shared by every trigger, so resolve and validate it once
  let warnedMissingUrl = false;

  for (const { trigger, subject } of pairs) {
    const parsed = subject ? parseFetchSubject(subject) : {};

    // URL value from `rz-fetch` takes precedence
    const url = parsed.url || elementUrl;

    // If the URL is missing, it could mean there isn't one configured,
    // or that it's in the wrong position (missing trigger).
    if (!url && !deferUrl) {
      if (__DEV__ && !warnedMissingUrl) {
        warn(
          `rz-fetch: no URL found. Configure it using data-rz-fetch (with at least one leading trigger), or a native 'href', 'action', or 'formaction' attribute.`,
          el,
        );
        warnedMissingUrl = true;
      }
      continue;
    }

    const cleanup = dispatchTrigger(trigger, {
      el,
      app,
      action: (e?: Event) => {
        if (e && isNativeNavigation(el, e)) {
          e.preventDefault();
        }
        const opts = applySubmitterOverrides({ ...parsed, url, triggerEl: el }, e);
        if (!opts.url) {
          __DEV__ &&
            warn(
              `rz-fetch: no URL found. Configure it using data-rz-fetch (with at least one leading trigger), or a native 'href', 'action', or 'formaction' attribute.`,
              el,
            );
          return;
        }
        runFetch(app, opts);
      },
    });

    if (cleanup) {
      cleanups.push(cleanup);
    }
  }

  return cleanups;
}

export const rzFetch = defineNetworkOpDirective('fetch', bindFetchPairs);
