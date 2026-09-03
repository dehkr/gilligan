import { getDirectiveValue } from '../core/attributes';
import { parseTriggers } from '../core/parser';
import type { ConfigDirective, TriggerDef } from '../types';

/**
 * Triggers that close the stream `rz-sse` opened on the same element. Unlike
 * `rz-wake`, these compose with OR: the first to fire closes.
 *
 * Read on demand by `rz-sse`, so nothing scans for it and an element carrying
 * it alone does nothing. `app.start()` warns about that case in dev.
 */
function getConfig(el: Element): TriggerDef[] {
  return parseTriggers(getDirectiveValue(el, 'close'));
}

export const rzClose = { getConfig } as const satisfies ConfigDirective<TriggerDef[]>;
