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
- **Lightweight** – 20kB gzipped with no external dependencies

## Features

### Reactive state

Model UI state in local scopes and global stores backed by signals, with a proxy layer for ergonomic object and array mutations.

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

Rouse ships as ES modules only, in two builds:

| Build | File | Use |
| --- | --- | --- |
| Development | `dist/rouse.js` | Default. Emits warnings and errors for misused directives, missing targets, and invalid values. |
| Production | `dist/rouse.min.js` | Minified, with all diagnostics stripped. |

Start with the development build. Switch to the minified one when you deploy.

### From a CDN

Import Rouse inside a module script and start the app. Rouse has no global side effects, so nothing runs until you call `rouse()`.

```html
<script type="module">
  import { rouse } from 'https://cdn.jsdelivr.net/npm/rousejs@0.11.0/dist/rouse.js';
  // Or use UNPKG: https://unpkg.com/rousejs@0.11.0/dist/rouse.js

  const app = rouse();
  app.start();
</script>
```

Swap in `rouse.min.js` for production:

```text
https://cdn.jsdelivr.net/npm/rousejs@0.11.0/dist/rouse.min.js
```

### From npm

```bash
npm install rousejs
```

```js
import { rouse } from 'rousejs';
```

Bundlers that set the standard `development` and `production` export conditions (Vite, webpack) get the dev build while you develop and the minified one when you build, with no extra configuration.

Tools that don't set those conditions, such as esbuild and Rollup, resolve to the minified build. Import the `dev` subpath when you want diagnostics (`rousejs/min` always resolves to the minified build):

```js
import { rouse } from 'rousejs/dev';
```

Types are bundled, so no additional setup for TypeScript is necessary.
