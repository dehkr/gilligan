import type { RouseApp } from '../core/app';
import { warn } from '../core/diagnostics';
import { dispatchTrigger } from '../dom/events';
import { openStream, type SseRelease } from '../net/sse-engine';
import type { SseCloseReason, TriggerSubjectPair, VoidFn } from '../types';
import { defineNetworkOpDirective } from './define-network-op';
import { rzClose } from './rz-close';

/** The element's live stream. Absent while closed, so a reopen is a fresh open. */
const activeStreams = new WeakMap<Element, SseRelease>();

function openFor(el: Element, app: RouseApp, url: string) {
  // Repeat triggers on a live stream are a no-op, not a second connection
  if (activeStreams.has(el)) return;

  const release = openStream(app, url, { triggerEl: el });
  if (release) {
    activeStreams.set(el, release);
  }
}

function closeFor(el: Element, reason: SseCloseReason) {
  const release = activeStreams.get(el);
  if (!release) return;

  activeStreams.delete(el);
  release(reason);
}

/**
 * Binds one stream: every trigger sharing the first pair's URL opens it, and the
 * `rz-close` triggers end it. Returns the pairs' cleanups.
 */
function bindSsePairs(el: Element, app: RouseApp, pairs: TriggerSubjectPair[]) {
  const cleanups: VoidFn[] = [];

  const url = pairs[0]?.subject;

  if (!url) {
    __DEV__ &&
      warn(
        `rz-sse: no URL found. Configure it using data-rz-sse with at least one leading trigger (e.g. data-rz-sse="ready: /events").`,
        el,
      );
    return cleanups;
  }

  // One stream per element: rz-close and rz-target each have one home here, and
  // rz:sse:open fires from one node. A second stream is a second element.
  const shared = pairs.filter((pair) => pair.subject === url);

  __DEV__ &&
    shared.length !== pairs.length &&
    warn(
      `rz-sse: only '${url}' is opened. One element carries one stream; share a URL across triggers with whitespace (data-rz-sse="wake click: /events").`,
      el,
    );

  for (const { trigger } of shared) {
    const cleanup = dispatchTrigger(trigger, {
      el,
      app,
      action: () => openFor(el, app, url),
    });

    if (cleanup) {
      cleanups.push(cleanup);
    }
  }

  for (const trigger of rzClose.getConfig(el)) {
    const cleanup = dispatchTrigger(trigger, {
      el,
      app,
      action: () => closeFor(el, 'released'),
    });

    if (cleanup) {
      cleanups.push(cleanup);
    }
  }

  // The connection outlives the triggers that opened it, so teardown ends it
  cleanups.push(() => closeFor(el, 'teardown'));

  return cleanups;
}

export const rzSse = defineNetworkOpDirective('sse', bindSsePairs);
