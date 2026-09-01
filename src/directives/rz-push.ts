import { bindStorePairs } from './bind-store-pairs';
import { defineNetworkOpDirective } from './define-network-op';

export const rzPush = defineNetworkOpDirective('push', (el, app, pairs) =>
  bindStorePairs('push', el, app, pairs),
);
