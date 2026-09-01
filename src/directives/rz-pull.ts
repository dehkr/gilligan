import { bindStorePairs } from './bind-store-pairs';
import { defineNetworkOpDirective } from './define-network-op';

export const rzPull = defineNetworkOpDirective('pull', (el, app, pairs) =>
  bindStorePairs('pull', el, app, pairs),
);
