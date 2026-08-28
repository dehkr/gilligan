# Rouse

[![npm](https://img.shields.io/npm/v/rousejs)](https://www.npmjs.com/package/rousejs)

**A JavaScript reactivity and state-synchronization layer for server-rendered HTML.**

> [!WARNING]
> **Pre-release software:** Rouse is currently in active development, unstable, and not intended for production use. Breaking changes will occur without notice.

## Introduction

Rouse coordinates server-rendered HTML and client-side reactivity within a single, cohesive system. While SPAs put the frontend in charge and hypermedia anchors to the backend, Rouse combines the strengths of each. It's designed for applications that already render HTML on the server but need rich client-side state without adopting a full SPA architecture. Whether the server or the client drives an interaction is a per-feature decision rather than an architectural commitment.

- **No virtual DOM** – native DOM, web standards, zero compilation
- **Backend agnostic** – pairs with anything that returns HTML or JSON
- **Strict CSP compliance** – no `unsafe-eval` or expression evaluation in markup
- **Buildless or bundled** – load from a CDN or install from npm, fully typed
- **Lightweight** – 19 KB gzipped with no external dependencies

## Features

### Reactive state

Model UI state in local scopes and global stores backed by [alien-signals](https://github.com/stackblitz/alien-signals), with a proxy layer for ergonomic object and array mutations.

### Native client rendering

Render dynamic lists and conditional views from reactive state with `<template>` elements. Keyed reconciliation reuses and reorders DOM instead of rebuilding it.

### Hypermedia interactions

Fetch HTML fragments – or JSON – on any event, straight from attributes. The server can steer targeting, issue redirects, and trigger client-side events through response headers.

### State synchronization

Push client state to the server and pull it back, with dirty tracking, conflict detection, and optional rollback on failure.

### Progressive activation

Gate any scope's activation on visibility, idle time, media queries, or custom events. Third-party scripts get an isolated mount point with lifecycle hooks and automatic cleanup.

### Declarative and programmatic

Attributes and the JavaScript API share the same engine. They mix freely. Start in markup and drop into code where you need it.

### Wiring in HTML, logic in JavaScript

Directive values are declarative: they describe paths, triggers, and targets. Logic stays in plain JavaScript, where it can be organized, typed, tested, and reused.

## Installation

Rouse ships as ES modules only, in two builds: a development build with diagnostics, and a minified production build.

### From a CDN

```html
<script type="module">
  import { rouse } from 'https://cdn.jsdelivr.net/npm/rousejs@0.12.0/dist/rouse.js';

  const app = rouse();
  app.start();
</script>
```

Swap in `rouse.min.js` for production:

```text
https://cdn.jsdelivr.net/npm/rousejs@0.12.0/dist/rouse.min.js
```

### From npm

```bash
npm install rousejs
```

```js
import { rouse } from 'rousejs';
```

Types are bundled. No additional setup for TypeScript necessary.

### Build selection

| Build | File | Use |
| --- | --- | --- |
| Development | `dist/rouse.js` | Emits warnings for misused directives, missing targets, and invalid values. |
| Production | `dist/rouse.min.js` | Minified, diagnostics stripped. |

Bundlers that set the standard `development`/`production` export conditions (Vite, webpack) get the right build automatically. Tools that don't (esbuild, Rollup) resolve to the minified build by default. Import `rousejs/dev` if you want diagnostics during development. `rousejs/min` always resolves to the minified build regardless of tool.

## Getting started

**Register your scopes, stores, interceptors, and listeners, then call `app.start()`.**

Order within that list does not matter. What matters is that it comes first.

```html
<div data-rz-scope="counter">
  <button data-rz-on="click: increment">Add one</button>
  <span data-rz-text="count"></span>
</div>

<script data-rz-store="user" data-rz-resource="/api/user" type="application/json">
  { "name": "Ada" }
</script>

<input data-rz-model="@user.name">
<button data-rz-push="click: @user">Save</button>
```

```js
import { rouse, signal } from 'rousejs';

const app = rouse();

// Scopes: a setup function bound to a region of the page
app.scope('counter', () => {
  const count = signal(0);
  return {
    get count() {
      return count();
    },
    increment() {
      count(count() + 1);
    },
  };
});

// Stores: shared state, optionally synced with the server
app.store('prefs', { theme: 'dark' });

// Interceptors: run on every request
app.interceptor('request', (config) => {
  config.headers = { ...config.headers, Authorization: `Bearer ${token}` };
  return config;
});

// Listeners
app.on('rz:app:ready', () => console.log('wired up'));

app.start();
```

### Why the order

`start()` is not an initialization step that switches Rouse on. **It scans the page.** Directives are read from the DOM at that moment and wired to whatever is registered by then.

So the rule is:

> Anything registered before `start()` is available to that scan. Anything registered after applies only to DOM that arrives later.

Registering after `start()` is legitimate, and it is how you wire up content added later, since Rouse keeps watching the page for new elements. It only surprises you when the markup was already there: a scope registered too late leaves its region unwired, and an interceptor registered too late misses requests the initial scan already fired.

One wrinkle worth knowing if you reach for `app.stores` early: `app.store()` registers on the call, while a `<script data-rz-store>` tag is registered *during* `start()`. Both are fine if you follow the order above, but `app.stores.onEdit('user', …)` placed above the `start()` line will not find a store that was declared in HTML. The development build warns when that happens.
