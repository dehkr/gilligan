import type { RouseApp } from '../core/app';
import { getDirectiveValue } from '../core/attributes';
import { parseTriggers } from '../core/parser';
import type { ConfigDirective, TriggerDef } from '../types';

function getConfig(el: Element, app: RouseApp): TriggerDef[] {
  const wakeTriggers = parseTriggers(getDirectiveValue(el, 'wake'));
  if (wakeTriggers.length === 0) {
    const wakeTriggersConfig = parseTriggers(app.config.wake);

    // Fall back to the app config or to `ready` if the config is malformed
    return wakeTriggersConfig.length === 0
      ? [{ event: 'ready', options: {} }]
      : wakeTriggersConfig;
  }
  return wakeTriggers;
}

export const rzWake = { getConfig } as const satisfies ConfigDirective<TriggerDef[]>;
