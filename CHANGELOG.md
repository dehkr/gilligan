# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Add the `rz-indicator` directive. Takes a CSS selector for elements that receive the `rouse-request` class while a request from the host element is in flight.
- Send three protocol headers on every push and pull: `Rouse-Sync` (`push` or `pull`), `Rouse-Store`, and `Rouse-Path` (when syncing a slice).
- Add new store helper functions:
  - `app.stores.baseline(name)` returns a copy of the last synced state, the reference point for unsaved changes.
  - `app.stores.commit(name)` sets the store's current data as the new baseline without sending anything to the server.
  - `app.stores.revert(name, path?)` discards unsaved changes by restoring from the last confirmed state.
  - `app.stores.isDirty(name, path?)` checks for unsaved store changes.
  - `app.stores.deposit(name, payload, options?)` routes a JSON response into a store.

### Changed

- **Breaking:** Consolidate the request-config directives. `rz-request` and `rz-fetch-request` become `rz-fetch-config`; `rz-push-request` and `rz-pull-request` become `rz-store-config` on the store element. `rz-push` and `rz-pull` are configured on the store, not on the trigger
- **Breaking:** Reconcile every store sync server payload as a [JSON Merge Patch (RFC 7396)](https://www.rfc-editor.org/rfc/rfc7396). Keys the payload omits are left alone, nested objects merge, arrays and primitives overwrite, and a key set to `null` is removed.
- **Breaking:** Change the store's `method` option to `push-method`. Pull is always `GET`, so a bare `method` implied it affected both directions.
- **Breaking:** Stop resolving direct `@store` and `#json-id` references in config values. Config directive values are literal text. `params` and `body` accept an inline JSON object; every other key takes its value as written.
- **Breaking:** Rename the store destination lifecycle events: `rz:store:sync` becomes `rz:store:patch`, along with `:before`, `:skipped`, and `:rollback`.
- **Breaking:** Reject store-only options on `ctx.fetch` and `app.fetch`. `ctx.fetch(url, { rollbackOnError: true })` was accepted and silently ignored; it is now a type error.
- **Breaking:** Pass the set of edited root keys to `app.stores.onEdit(name, callback)` callbacks, which previously received no arguments.
- **Breaking:** Always roll a store back when a push fails; `rollback-on-error` and the `rollbackOnError` option are removed. A push that fails while the user has kept editing, or whose data already matches the last-good baseline, still leaves state alone.
- **Breaking:** Require the `data-` prefix on every directive attribute; e.g. `rz-on` becomes `data-rz-on`.
- Merge programmatic headers with declarative ones per key instead of replacing them wholesale.
- Fire the same events with the same detail when a fetch response is deposited into a store as when a push or pull writes to it, including `payload` and `response`.

### Removed

- **Breaking:** Remove the `target` and `swap` fetch options, and stop `ctx.fetch` from targeting the scope host. `triggerEl` can be set to route a response through that element's `rz-target`, or place HTML manually with the exported `swap`.
- **Breaking:** Remove store context aliasing for scopes. `rz-scope="@store"` no longer aliases store data. Reference stores directly from directives instead.
- **Breaking:** Remove `rz-fetch-headers`, `rz-push-headers`, and `rz-pull-headers`.
Use `rz-headers` to set headers declaratively.
- **Breaking:** Remove the `rz-url` directive; subsumed by the `url` field in `rz-fetch-config` and `rz-store-config`.
- **Breaking:** Remove `@store` references as URLs. A dynamic endpoint belongs in an interceptor or a programmatic call.
- **Breaking:** Remove `pullMethod` from store config. A pull carries no body, so it is always `GET`.
- **Breaking:** Remove `method` from the options bag of `app.stores.push()` and `.pull()`. Set `pushMethod` on the store instead.
- **Breaking:** Remove `mode`, `referrer`, `referrer-policy`, `integrity`, and `priority` keys from the config directives. They remain available programmatically and through a request interceptor.
- **Breaking:** Remove the patch action everywhere it could be set: `rz-store-config="action: …"`, the `action` option on `push()` / `pull()` / `deposit()`, and the `action` field on every `rz:store:patch:*` event detail. Reconciliation is always a merge.
- **Breaking:** Remove the `reason` field from the `rz:store:patch:rollback` event detail. It only ever held `'push-error'`, which the event name and the accompanying `error` already convey.

### Fixed

- Apply only the newest push or pull to a store. Two overlapping requests could previously write to the store in arrival order, letting a slow earlier response overwrite a newer one (or roll back to a stale snapshot on failure).
- Take `reset()` and rollback snapshots from the store's data rather than the incoming payload. Under `merge`, a partial payload became the restore target, so a later `reset()` or a failed push restored a partial store.
- Clear a store's dirty flag when an edit is reverted.

## [0.12.0] - 2026-08-13

### Added

- Add `development` and `production` export conditions, so bundlers that set them (Vite, webpack) resolve to the development build while developing and the minified one when building.
- Add a `rousejs/dev` subpath that resolves to the development build.
- Add the `indicator` option to the `rz-request` family. Accepts a CSS selector for elements to receive the `rouse-request` class for the duration of the request. Defaults to the triggering element; `indicator: null` suppresses the class.

### Changed

- **Breaking:** Resolve `rousejs` to the minified build by default instead of the development build, which was shipping diagnostics to production. Use `rousejs/dev` for diagnostics in tools that don't set the `development` condition.
- **Breaking:** Rename the in-flight class from `rz-loading` to `rouse-request`.
- **Breaking:** Rename `rz:store:sync:conflict` to `rz:store:sync:skipped` and drop its `reason` field.
- **Breaking:** Reference store status via the `::` namespace operator. `@cart::status.loading` replaces `@cart.__status.loading`, and `__status` is no longer a property of the store data proxy.
- **Breaking:** Rename trigger sources that shadowed native DOM events:
  - `load` -> `page-loaded`
  - `online` -> `network-online`
  - `offline` -> `network-offline`
- **Breaking:** Stop suppressing native anchor and form navigation for listeners attached programmatically with `app.on`/`ctx.on`.
- **Breaking:** Separate modifiers from the event with `|` instead of `.` (e.g., `click|debounce.once`). Modifiers remain dot-separated.
- **Breaking:** Write the optional wait for debounce and throttle modifiers using a dash; `click|debounce-300ms` replaces `click|debounce.300ms`.
- **Breaking:** Prefix key modifiers with `key-`, matching any `KeyboardEvent.key` value (e.g., `keyup|key-arrowup`, `keydown|ctrl.key-escape`). Replaces a fixed token list, so keys no longer need to be registered to be usable.
- **Breaking:** Pass trigger modifiers to `app.on`/`ctx.on` as an options object: `app.on('click', onClick, { debounce: 300, once: true })`.
- **Breaking:** Accept multiple events for `app.on`/`ctx.on` as an array rather than a whitespace-separated string: `app.on(['page-visible', 'network-online'], sync)`.
- **Breaking:** Move the `AbortSignal` argument of `app.on`/`ctx.on` into the options object as `signal`, matching `addEventListener`.
- Allow bare number timing modifiers that resolve to milliseconds (e.g., `interval|300`).
- Update `interact` to listen on `pointerover` and `focusin` rather than `mouseover`, `focusin`, and `touchstart`.
- Accept an object with a `handleEvent` method as the listener for `app.on`/`ctx.on`, matching `addEventListener`.

### Removed

- **Breaking:** Remove the automatic `aria-busy="true"` on the triggering element. Apply it from an `rz:fetch:start`/`:end` listener pair instead.
- **Breaking:** Remove `readOnly` and `nonReactive`.
- **Breaking:** Remove `retry`/`retryDelay` and declarative `retry`/`retry-delay` from `rz-request`. Use conditional triggers (`rz-pull="page-visible: @users"`) or handle retries in an `rz:fetch:error` listener. `timeout` is unaffected.
- **Breaking:** Remove the HTTP-method aliases on `app.fetch` and `ctx.fetch`. Pass the method in options: `fetch(url, { method: 'POST' })`.
- **Breaking:** Remove the `edges` timing modifier. Write `leading.trailing`, which is now equivalent.

### Fixed

- Fix the `once` modifier being ignored by trigger sources that don't self-terminate: `interval`, `network-online`, `network-offline`, `page-visible`, and `page-hidden`.
- Stop `app.fetch` and `ctx.fetch` from defining `triggerEl` by default. Only `rz-fetch` sets it automatically, naming the element hosting the directive.
- Fix `leading` and `trailing` modifiers overwriting each other. The two edges are now independent.

## [0.11.0] - 2026-07-27

### Added

- Add new key modifiers: `home`, `end`, `pageup`, `pagedown`, `insert`, `f1`–`f12`, and `escape` as an alias of `esc`.
- Add `rz:push:*` and `rz:pull:*` request-lifecycle events, fired from the trigger element and mirroring `rz:fetch:*`.
- Consume the `Rouse-Trigger` response header on `rz-push`/`rz-pull` responses, dispatching the named event from the trigger element.
- Add loading affordances (`rz-loading` class, `aria-busy="true"`) to the trigger element for the duration of a push/pull.
- Make `rz:store:sync:before` cancelable with a mutable `payload` on all paths (push, pull, and fetch `@store` deposits); listeners can reassign or mutate `detail.payload` before reconciliation.
- Add the `app.on()` listener method that defaults to `app.root` and auto-removes on `app.destroy()`.

### Changed

- **Breaking:** Allow headers with empty values instead of removing them (e.g., `rz-headers="Rouse-Request: ''"`). Use `null` for the value to remove a header.
- **Breaking:** Require an explicit value per header in the `rz-headers` family..
- **Breaking:** `rz:store:sync` events now report `operation: 'fetch'` for `rz-target="@store"` JSON deposits (previously `'pull'`).
- **Breaking:** `rz-target="@store"` deposits now update the store's `__status.lastSync`.

### Fixed

- Fix system modifier keys (e.g., `.alt`) incorrectly matching as regular keys in combos.
- Fix bare triggers (e.g., `keydown` with no key modifiers) not firing while a modifier key was held.
- Fix `.once` modifier bug that prevented events with multiple modifiers from firing.
- Fix `rz-fetch` on forms ignoring a submit button's `formaction` when no other URL source was set.
- Warn and skip on a trailing colon in directive values (e.g., `rz-headers="Key: "`) instead of corrupting the key.
- Fix the array `at()` method returning stale values after a reordering mutation (e.g., `unshift`, `splice`).
- Prevent a JSON array or primitive routed to a store via `rz-target="@store"` from corrupting store state. Non-object payloads are now rejected with a warning.
- Fire the `rz:scope:destroy` lifecycle event after `rz:scope:disconnect`.

### Removed

- **Breaking:** Remove `trigger` and `effectScope` from public exports.
- **Breaking:** Remove `rz:store:sync:error`; a failed sync is now reported on the request axis by `rz:push:error`/`rz:pull:error`.
- **Breaking:** Remove the `dispatchEvents` request option (and its `dispatch-events` declarative key).
- **Breaking:** Remove the importable `on` helper. Use `app.on`/`ctx.on`.
- **Breaking:** Remove `dispatch` and `swap` from the scope context. Use importable `dispatch`/`swap`, which take an explicit target.

## [0.10.0] - 2026-07-08

### Added

- Add `rz-render` directive for rendering `<template>` elements. Reconciliation is keyed (positional by default), so instances are reused and reordered rather than rebuilt. Behavior is determined by the resolved value:
  - **Boolean:** renders the contents once, or not at all.
  - **Number:** renders them that many times.
  - **Object:** renders once, with the object as the item.
  - **Array:** renders one instance per element.
- Expose the current render item to a template via the `%` prefix (e.g. `rz-text="%name"`).
- Add `rz-key` directive for explicit, stable reconciliation keys for render items (e.g. `rz-key="id"` or `rz-key="user.id"`).
- Add `createKey()` utility for assigning stable identity to client-created items (pairs with `rz-key`).
- Expose the render loop context to store and scope methods via `HandlerCtx.render`.
- Add per-item teleport via a `renderTarget` property to place a rendered instance anywhere within the app root boundary.
- Add `RenderHandlerCtx` type for handlers bound inside an `rz-render` instance.
- Add server-driven error-response routing. When an error response (4xx/5xx) carries a `Rouse-Target` header, its body is routed to the named element (HTML swapped) or store (JSON).
- Add HTTP-method aliases on programmatic fetch; e.g., `app.fetch.post(url)`.
- Add `readOnly` to the public exports for creating immutable views of reactive data.

### Changed

- **Breaking:** Rename the store sync operations `save`/`refresh` to `push`/`pull`; directive names, methods, and properties updated accordingly (e.g., `rz-save` renamed `rz-push`).
- **Breaking:** Require explicit triggers for `rz-fetch`, `rz-push`, `rz-pull`, and `rz-on`.
- **Breaking:** Stop parsing an HTTP method from `rz-url` values; method can be configured using `rz-push-request` and `rz-pull-request` (e.g., `rz-push-request="method: PUT"`).
- **Breaking:** Rename the `ScopeFn` type to `ScopeSetup`.
- **Breaking:** Rename `data` to `params` in `ScopeCtx` and `HandlerCtx`.
- Strip `[Rouse]` console warnings and errors from the minified build; standard build provides full diagnostics for development.
- `rz:fetch:error` now carries the full `RouseResponse` (with `error` populated), matching `rz:fetch:success`.
- Expose the parsed error body to the `error` interceptor via `RequestError.body`.

### Fixed

- Fix broken trailing edge option for the `throttle` event modifier.
- Prevent `rz-model` from silently creating missing fields.
- Fix URL construction so protocol-relative URLs (`//`) are not treated as absolute.

### Removed

- **Breaking:** Remove `rz-error` directive. Handle error responses with the new server-driven error response routing, an `error` interceptor, or by listening to the `rz:fetch:error` event.
- **Breaking:** Remove `__actions` facade from `StoreManager`.
- **Breaking:** Remove server-driven store `JSON.__meta` processing.
- **Breaking:** Remove `defineScope()` type inference function.

## [0.9.0] - 2026-06-20

### Added

- Enable `rz-text`, `rz-html`, and `rz-attr` to invoke functions with a resolved payload, using the same data injection protocol as `rz-on` and `rz-scope`. Functions receive a `HandlerCtx` where `e` is a synthetic `CustomEvent` typed as `rz:${slug}`.
- Add `rz-prop` directive for assigning values to element properties.
- Add `rz-class` and `rz-style` directives using conditional class/style binding with a `[tokens]: [condition]` grammar plus a single-key fallback for parity with `rz-attr`.

### Changed

- **Breaking:** Rename `ActionCtx` to `HandlerCtx` to reflect that the same context shape is now used for both event handlers (`rz-on`) and one-way binding formatters (`rz-text`, `rz-html`, `rz-attr`).
- **Breaking:** Rename `defineController` to `defineScope`, `ControllerCtx` to `ScopeCtx`, and `ControllerFn` to `ScopeFn`.
- **Breaking:** Rename `rz-bind` directive to `rz-attr`.
- **Breaking:** Rename `insert()` to `swap()`.
- **Breaking:** Rename `rz:dom:update` lifecyle events to `rz:dom:swap`.
- **Breaking:** Rename `scope` to `host` and `root` to `appRoot` in `ScopeCtx`.
- **Breaking:** Rename `props` to `data` in `ScopeCtx` and `HandlerCtx`.
- **Breaking:** Make `HandlerCtx.data` required (now defaulting to `{}` when a data payload isn't provided) to allow user code to read `data.x` without optional-chaining guards.
- **Breaking:** Require explicit triggers for non-interactive elements when using `rz-on`, `rz-fetch`, `rz-save`, and  `rz-refresh`.
- Wrap store and reactive proxy getters in `computed()`, binding `this` to the proxy.
- Pass the state-literal type through `app.store()` and `StoreManager.create()` as a generic parameter to ensure `this` inside object-literal getters resolves to the store shape.
- Allow passing data slices when using JSON-script (`#`) data payloads (e.g., `rz-html="displayItems#inventory.items"`).
- Render absent paths as a valid empty state for one-way bindings (`rz-text`, `rz-html`, `rz-attr`), consistent with a key that holds `undefined`.
- Extend `rz-model` with trigger-subject grammar and custom-element support.

### Fixed

- Prevent store getters from firing during snapshot creation which froze derived values.
- Prevent methods in stores from being deleted on `reset()` and `update()`.

### Removed

- **Breaking:** Remove URL params option for injecting data payloads.
- **Breaking:** Remove `rz-validate` directive and form validation engine.
- **Breaking:** Remove the `dom` synthetic event; use `ready` (app-ready, which already implies DOM-ready) or `load` (waits for all assets).

## [0.8.0] - 2026-05-25

### Added

- Add `rollbackOnError` option for store saves to enable auto-reverting local state on save failure.
- Add support for `Rouse-Push-Url` and `Rouse-Replace-Url` response headers to allow server-side browser address bar updates after fragment fetches.
- Add native redirect detection to handle server redirects (e.g., expired sessions routing to `/login`) by redirecting the browser instead of injecting the response into the page fragment.
- Add security block for cross-origin redirects, surfacing them as catchable errors.

### Changed

- **Breaking:** Rename `rz-request` and `rz-headers` variants to `rz-{save,fetch,refresh}-request` and `rz-{save,fetch,refresh}-headers`.
- **Breaking:** Rename `app.register()` to `app.controller()`.
- **Breaking:** Rename `controller()` to `defineController()`.
- **Breaking:** Flatten and simplify app config:
  - Move `network.baseUrl` to `baseUrl`.
  - Move `network.fetch.headers` to `headers`.
  - Move `network.fetch.credentials` to `credentials`.
  - Move `ui.wakeStrategy` to `wake`.
  - Remove `timing.*`, `ui.errorClass`, `ui.loadingClass`, and `network.fetch.mode`.
- **Breaking:** Clean up and rename synthetic events:
  - Rename `mutate` to `edit`.
  - Rename `interaction` to `interact`.
  - Remove `back` event.
- Enable bound directives (`rz-bind`, `rz-html`, `rz-model`, `rz-on`, `rz-text`) to live outside a local controller scope (`rz-scope`). They will now mount to the global scope and resolve against reactive stores (`@store`).
- Convert network interceptors from a static, single-function configuration model (`app.config.network.interceptors`) to a dynamic, composable registry (`app.interceptor()`).
- Type-narrow `dispatch()` and `on()` against a new `LifecycleEventMap`. Listener callbacks and dispatch sites now receive (and check) the correct `event.detail` shape for every `rz:*` event.

### Fixed

- Fix `rz-save="edit"` firing on framework-driven store writes. The `edit` trigger now fires only on user edits to store data.
- Clear `status.dirty` flags on `app.stores.update()` and `app.stores.reset()`.

## [0.7.0] - 2026-05-20

### Added

- Support server-driven flow control via `Rouse-Target`, `Rouse-Trigger`, and `Rouse-Redirect` headers allowing backends to dynamically override routing, emit DOM events, or force redirects.
- Add `rz-headers` directive to simplify configuration of custom request headers.
- Add per-action variants of `rz-request` and `rz-headers` (`rz-request-{save,fetch,refresh}` and `rz-headers-{save,fetch,refresh}`) to allow granular configuration of each operation type.
- Add `rz-error` directive for handling HTML and JSON error routing.
- Add `rz-validate` directive for granular field-level error feedback.
- Implement form validation engine that maps JSON errors to UI inputs, including automatic error text injection, ARIA attributes, and state clearing on interaction.
- Add `rz:store:sync:before`, `rz:store:sync`, `rz:store:sync:conflict`, and `rz:store:sync:error` lifecycle events.
- Add `retryDelay` configuration (supporting numbers or functions) to replace implicit exponential backoff.
- Add `back`, `intersect`, `interaction`, `idle`, `timeout`, `media`, `dom`, `load`, and `ready` synthetic events for use in directives and programmatic `on` utility.
- Add `rz-url` directive to configure request URLs on any element, with automatic fallback to `href` or `action`.
- Add `app.stores.elementFor(name)` accessor to retrieve the source `<script rz-store>` element for a registered store.
- Add case-insensitive HTTP method shorthand for `rz-url` and `rz-fetch`. Supports `[METHOD] [URL]` syntax with automatic fallbacks to `action` or `href`.
- Add inline patch action shorthand (`replace`, `merge`) for `rz-save` and `rz-refresh` to override store-level defaults.
- Support nested-path refresh (e.g., `rz-refresh="@store.field"`) to allow targeted slice updates.
- Add inferred default triggers across all network directives and `rz-on`: `submit` for forms, `change` for inputs, and `click` for other elements.

### Changed

- **Breaking:** Rename lifecycle events:
  - `rz:fetch:insert:before` to `rz:dom:update:before`.
  - `rz:fetch:insert` to `rz:dom:update`.
- **Breaking:** Rename `retries` configuration option to `retry`.
- **Breaking:** Rename `poll` synthetic event to `interval`.
- **Breaking:** Replace `reconnect` synthetic event with `online` and `offline`.
- **Breaking:** Replace `focus` synthetic event with `page-visible` and `page-hidden`.
- **Breaking:** Standardize `rz-on` to split multi-event triggers by whitespace instead of commas.
- **Breaking:** Unify network directive grammar (`rz-fetch`, `rz-save`, `rz-refresh`) to use the `[trigger]: [subject]` format.
- Upgrade `rz-target` to support JSON payload routing to stores (e.g., `rz-target="@user-data"`).
- Allow removal of default `Rouse-Request` header via `''` or `null` assignment to prevent CORS issues with 3rd-party APIs.
- Enable store paths that resolve to strings to be used as URL values for `rz-fetch` and `rz-url`.

### Fixed

- Fix `onError` interceptor to only fire on the final attempt.
- Apply `timeout` across the entire request lifecycle instead of resetting per retry.
- Resolve `baseUrl` correctly against `action` and `href` attributes when the API and page origins differ.
- Resolve slice-refresh dirty-flag leak by replacing `_runPatch()` with a generic `_withPatchGuard(fn)`.
- Honor `formaction` and `formmethod` attributes on `rz-fetch` form submit buttons.

### Removed

- **Breaking:** Remove `rz-trigger` directive; functionality is now handled by inline triggers in `rz-fetch`.
- **Breaking:** Remove `rz-source` directive; replaced by `rz-url` and `rz-request-*` variants.

## [0.6.0] - 2026-04-20

### Added

- Add `nonReactive()` and `readOnly()` utilities to control object reactivity and prevent accidental mutations.
- Add metadata (`__meta`) parsing for JSON payloads to handle `nonReactive` and `readOnly` instructions automatically.
- Add granular UI state tracking via `__status` property (includes `loading`, `error`, `lastSync`, and `dirty` flags).
- Add `__actions` object to store proxies to expose `save`, `refresh`, and `reset` methods for declarative use (e.g., `rz-on="click: @cart.__actions.save"`).
- Add support for `merge` operations on store data (previously only `replace` was supported).
- Introduce `ActionCtx<T, P>` generic type for event target typing.
- Implement global store context aliasing for `rz-scope`.

### Changed

- **Breaking:** Rename `el` to `scope` and `abortSignal` to `term` in controller context.
- **Breaking:** Update event actions to receive a context object `{ el, e, props }` instead of positional arguments.
- **Breaking:** Standardize on kebab-case for directive values and modifiers (e.g., `stop-immediate`, `abort-key`).
- **Breaking:** Rename `app.addStore()` to `app.store()` and return the store instance instead of the app instance.
- **Breaking:** Split `app.stores.define` into strict `create` and `update` methods.
- Refactor DOM observation to use a single app-level `MutationObserver`, significantly reducing memory overhead in deep trees.
- Make the target element argument optional for `on` and `dispatch` utilities in the controller context.
- Rename `SetupContext` generic type to `ControllerCtx`.

### Fixed

- Fix URL resolution for standalone inputs on `GET` requests to respect `baseUrl`.
- Scope DOM queries to `app.root` within `rz-insert` to prevent cross-app data leakage and ensure all DOM mutations are captured.
- Fix macOS `alt` key modifier issue that prevented some key combinations.
- Fix shallow merge bug in the global app configuration.

## [0.5.0] - 2026-04-05

### Added

- Add support for declarative timing modifiers (e.g., `.debounce`, `.throttle.500ms`, `.leading`) for `rz-on`.
- Export `debounce` and `throttle` utilities for programmatic use.
- Add `rz-trigger` directive to provide explicit event triggers with modifiers for `rz-fetch`.
- Add support for `none` value for `rz-trigger` to register fetch configuration on an element without binding DOM event listeners.
- Add synthetic `poll` event (e.g., `poll.30s`) for event-driven network directives (`rz-trigger`, `rz-refresh`).
- Expand programmatic `fetch` configuration options with new capabilities:
  - `params` for query string serialization (e.g., `ctx.fetch('/api/search', { params: { q: 'test' } })`).
  - `mutate` flag (set to `false` by default) to prevent automatic DOM insertion of HTML responses.
- Add `rz-source` directive for declarative configuration of store endpoints.
- Add `stopImmediate` event modifier to trigger `stopImmediatePropogation()`.
- Add support for `ms`, `s`, and `m` suffixes (e.g., `timeout: 10s`).
- Export `on` utility for programmatic event listening and modifier support. Available as a global import and in controller context (`ctx.on()`) where it includes automatic listener cleanup.
- Inject `abortSignal` into controllers (`ctx.abortSignal`). This signal automatically aborts when the controller disconnects, making it easy to cancel background tasks and prevent memory leaks.

### Changed

- **Breaking:** Rename `createApp()` to `rouse()` for framework initialization.
- **Breaking:** Rename `appRoot` to `root` in controller context for API consistency.
- **Breaking:** Update `rz-fetch` and `rz-autosave` syntax to use comma-separated values.
- **Breaking:** Update `rz-autosave` to accept an HTTP method and debounce override (e.g., `rz-autosave="PUT, 800ms"`).
- **Breaking:** Refactor global configuration into a domain-driven schema (`timing`, `network`, `ui`):
  - Move fetch defaults to `app.config.network.fetch` and restrict properties to `headers`, `credentials`, and `mode`.
  - Remove global `retry` and `timeout` settings; these can be configured per-request.
- Inject the controller `AbortSignal` into `ctx.fetch()` options to automatically cancel background requests when a controller disconnects.
- Update `rz-refresh` to support arbitrary event trigger and modifiers, while introducing global configuration to opt-out of default `focus` and `reconnect` behaviors.

### Removed

- **Breaking:** Remove `rz-tune` directive. Transfer network options (`retries`, `timeout`, `abortKey`) to `rz-request` and event triggers (including `poll`) to `rz-trigger`.
- **Breaking:** Remove the event bus and `rz-publish` directive.
- **Breaking:** Remove XHR fallback support; Rouse now exclusively uses the Fetch API.

## [0.4.0] - 2026-03-18

### Added

- Expose the root element of app instances in controllers via `ctx.appRoot`.
- Add lifecycle DOM events for applications and controllers:
  - **App:** `rz:app:start`, `rz:app:ready`, and `rz:app:destroy`
  - **Controllers:** `rz:controller:init`, `rz:controller:connect`, `rz:controller:disconnect`, and `rz:controller:destroy`
- Add support for declarative event modifiers in the `rz-on` directive:
  - **Event control:** `.prevent`, `.stop`, `.once`, `.passive`, `.capture`
  - **Target filtering:** `.self`, `.outside`, `.window`, `.document`, `.root`
  - **Keyboard keys:** `.enter`, `.esc`, `.space`, `.up`, `.down`, `.left`, `.right`, `.tab`, `.delete`, `.backspace`, plus any single character (e.g., `.a`, `.1`)
  - **System modifiers:** `.ctrl`, `.alt`, `.shift`, `.meta`
  - **Matching mode:** All modifiers are matched exactly by default (e.g., `.enter` fires only on bare Enter, not Shift+Enter). Use `.loose` to match when additional modifier keys are pressed.

### Changed

- **Breaking:** Rebuild `rz-publish` as a standalone event-broadcasting directive, decoupled from `rz-fetch`. This allows for native DOM event support and custom payloads independent of network requests.

### Fixed

- Prevent erroneous splitting of inline JSON in directive values by ignoring commas located within curly braces.
- Fix a bug where fetching binary files (like images or PDFs) corrupted the data by coercing the response to text.

## [0.3.0] - 2026-03-11

### Added

- Enable explicit access to global stores in HTML with the `@` prefix: `rz-model="@user-state.name"`.
- Introduce new delimiters for passing data into controllers and methods: `?` for URL params and `@` for store data.
- Support a `request` property in the app configuration to establish Fetch API defaults (e.g., `mode`, `credentials`, `headers`).
- Add the `rz-request` directive for declarative, DOM-scoped Fetch API configuration.

### Changed

- **Breaking:** Update directive parsing to require a comma and white space to separate multiple values.
- **Breaking:** Rename `rz-island` directive to `rz-scope`.
- **Breaking:** Remove the `#` delimiter for inline JSON payloads. Use the JSON object directly after the name: `rz-scope='counter{ "count": 5 }'`.
- **Breaking:** Replace `request()` with `fetch()` in programmatic API to trigger network requests while retaining lifecycle events and DOM mutations.
- Decouple `rz-fetch` execution logic into a centralized network engine to support both declarative and programmatic APIs.
- Refine fetch method resolution to follow a strict priority cascade for configuration.
- Improve fetch lifecycle events by including helpful details when dispatched.
- Refactor the network engine to use dependency injection to avoid multiple app instances overwriting each other's network configuration.
- Extract dot-notation path parsing logic into separate module.

### Fixed

- Prevent accidental JSON serialization of `DataView` and `TypedArray` types in request bodies by enhancing binary type checks.
- Prevent GET requests from including a body to avoid server-side errors.
- Warn and dispatch `rz:fetch:error` when a request is missing a URL instead of failing silently.
- Respect the native `method` attribute on `<form>` elements.

### Removed

- **Breaking:** Remove `rz-state` directive. The new `@` prefix for accessing global stores makes it redundant.
- **Breaking:** Remove top-level `headers` property from app configuration (moved to `request` object).

## [0.2.0] - 2026-03-04

### Added

- Add `rz-state` directive for declarative mapping of global store data to an island's scope. Supports multiple stores and optional namespace aliasing.
- Add support for controller-less islands. `rz-island` no longer requires a controller name, allowing reactive global state binding to HTML with zero JavaScript boilerplate.

### Changed

- **Breaking:** Rename `rz-use` directive to `rz-island`.
- **Breaking:** Rename RouseApp `store()` method to `addStore()`.
- Text and HTML bindings (`rz-text`, `rz-html`) now auto-format values: primitive arrays render comma-separated, objects and nested arrays as formatted JSON.
- Optimize dot-notation path parsing with a memory cache.
- Make dot-notation path parsing log a warning and bail out instead of overwriting primitive values.

## [0.1.1] - 2026-03-01

### Added

- Add RouseApp `destroy()` method for manual teardown of app instances (stops timers, removes listeners, unmounts controllers, and frees memory).

### Changed

- Support bulk registration via object shorthand for the `register()` method. E.g., `app.register({ Counter, Cart })`.
- Improve runtime validation for `register()` with descriptive error messages and strict type checking for setup functions.

## [0.1.0] - 2026-02-28

First pre-release of RouseJS.

### Added

- Support for multiple isolated app instances on the same page.
- Declarative HTML API for binding data and behavior to elements.
- Controllers with fine-grained activation strategies.
- Configurable data fetching with support for both HTML and JSON.
- Event bus for message routing between islands.
- Signal-based reactivity via [alien-signals](https://github.com/stackblitz/alien-signals#readme).
- Reactive proxy layer that wraps signals for ergonomic object and array state.
- Global state management with reactive stores.
- Optimistic UI updates with automatic rollbacks.
