import { effect, signal } from 'alien-signals';
import type { RouseApp } from '../core/app';
import { ITEM_KEY, ITEM_META_KEY, RENDER_PARENT } from '../core/constants';
import { warn } from '../core/diagnostics';
import { getNestedVal } from '../core/path';
import { isPlainObject } from '../core/state';
import { getRaw, reactive, untracked } from '../reactivity/reactive';
import type { BoundCleanupFn, RenderContext, RenderMeta, Scope, VoidFn } from '../types';
import {
  bindDirectives,
  markRenderOwned,
  unmarkRenderOwned,
  walkBoundElements,
} from './binder';

type RenderMode = 'array' | 'object' | 'number' | 'boolean';

type IndexSignal = {
  (): number;
  (value: number): void;
};

type ItemSignal = {
  (): unknown;
  (value: unknown): void;
};

interface ItemPlan {
  item: unknown;
  index: number;
}

interface NormalizedValue {
  mode: RenderMode;
  items: ItemPlan[];
}

interface InstanceRecord {
  key: string | number;
  item: unknown;
  itemSig: ItemSignal;
  indexSig: IndexSignal;
  roots: ChildNode[];
  target: Element | null;
  teardown: VoidFn;
}

/** Options the directive feeds the engine. */
interface RenderOptions {
  app: RouseApp;
  parentState: Scope;
  keyPath?: string | null;
}

/** Placeholder item for render modes with no per-item data (boolean/number). */
const NO_ITEM: Record<string, unknown> = {};

/**
 * Wraps an item in a reactive proxy when it's an object, so bound directives
 * track its fields. Passes primitives through untouched.
 */
function toItemProxy(item: unknown): unknown {
  return reactive(item as object);
}

/**
 * Classifies the resolved render value and lays out the instances to render.
 *
 * - Boolean: render the contents once or not at all
 * - Number: renders them that many times
 * - Object: renders once with the object as the item
 * - Array: renders one instance per element
 *
 * Iterates arrays through the reactive interceptor so structural changes
 * (including in-place reorders) re-run the render.
 */
function normalize(value: unknown): NormalizedValue {
  if (Array.isArray(value)) {
    const items: ItemPlan[] = [];
    value.forEach((item, index) => items.push({ item, index }));
    return { mode: 'array', items };
  }

  if (typeof value === 'number') {
    const n = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
    const items: ItemPlan[] = [];
    for (let i = 0; i < n; i++) {
      items.push({ item: NO_ITEM, index: i });
    }
    return { mode: 'number', items };
  }

  if (isPlainObject(value)) {
    return { mode: 'object', items: [{ item: value, index: 0 }] };
  }

  // `boolean` and anything else: truthy renders once, falsy renders nothing
  return {
    mode: 'boolean',
    items: value ? [{ item: NO_ITEM, index: 0 }] : [],
  };
}

/**
 * Resolves the reconciliation key. Positional by default. An explicit `rz-key`
 * path keys by a stable field. A missing/null explicit key warns and falls back
 * to position.
 */
function keyFor(
  plan: ItemPlan,
  mode: RenderMode,
  keyPath: string | null,
  onMissing: (index: number) => void,
): string | number {
  if (mode === 'boolean' || mode === 'number' || !keyPath) {
    return plan.index;
  }

  const explicit = getNestedVal(plan.item, keyPath);
  if (explicit == null) {
    onMissing(plan.index);
    return plan.index;
  }

  return explicit as string | number;
}

/**
 * Renders a `<template>`'s contents from a reactive value and keeps them
 * reconciled. Resolves the value via `source` inside a tracked effect. On every
 * change it diffs by key and creates, reuses, moves, or removes instances.
 * Returns a teardown that stops tracking and tears every instance down.
 */
export function renderTemplate(
  template: HTMLTemplateElement,
  source: () => unknown,
  opts: RenderOptions,
): VoidFn {
  const { app, parentState, keyPath = null } = opts;

  const records = new Map<string | number, InstanceRecord>();
  let currentMode: RenderMode | null = null;
  let keyWarned = false;
  let dupWarned = false;

  /**
   * Creates one rendered instance. Clones the template contents, layers the item,
   * index and key onto a render context, binds the cloned directives against it,
   * and teleports the nodes to a target when the item requests one.
   */
  function buildInstance(plan: ItemPlan, instanceKey: string | number): InstanceRecord {
    const frag = template.content.cloneNode(true) as DocumentFragment;
    const roots = Array.from(frag.childNodes);
    const elementRoots = roots.filter(
      (n): n is Element => n.nodeType === Node.ELEMENT_NODE,
    );

    // Collect directive elements before marking render-owned, so the binder
    // guard doesn't reject our own walk.
    const collected: Element[] = [];
    for (const root of elementRoots) {
      walkBoundElements(root, (e) => collected.push(e));
    }

    const itemSig: ItemSignal = signal(toItemProxy(plan.item));
    const indexSig: IndexSignal = signal(plan.index);
    const hasItem = plan.item !== NO_ITEM;
    const meta: RenderMeta = {
      get index() {
        return indexSig();
      },
      get item() {
        return hasItem ? itemSig() : undefined;
      },
      key: instanceKey,
    };

    const ctx = new Proxy(parentState, {
      get(t, k) {
        if (k === ITEM_KEY) return itemSig();
        if (k === ITEM_META_KEY) return meta;
        if (k === RENDER_PARENT) return parentState;
        return Reflect.get(t, k, t);
      },
      has(t, k) {
        return (
          k === ITEM_KEY ||
          k === ITEM_META_KEY ||
          k === RENDER_PARENT ||
          Reflect.has(t, k)
        );
      },
    }) as RenderContext;

    for (const root of elementRoots) {
      markRenderOwned(root);
    }

    // Detach from the render effect's tracking so these per-instance effects
    // survive its re-runs (and don't leak into it).
    const cleanups: BoundCleanupFn[] = [];
    untracked(() => {
      for (const e of collected) {
        for (const fn of bindDirectives(e, ctx, app)) {
          cleanups.push(fn);
        }
      }
    });

    // Per-item teleport. `renderTarget` accepts a selector string or
    // a direct Element reference.
    let target: Element | null = null;
    const item = plan.item;
    const rt =
      item && typeof item === 'object'
        ? (getRaw(item) as Record<string, unknown>).renderTarget
        : undefined;

    let dest: Element | null = null;
    if (typeof rt === 'string' && rt) {
      dest = app.root.querySelector(rt);
      if (!dest) {
        __DEV__ && warn(`rz-render: render target '${rt}' not found.`);
      }
    } else if (rt instanceof Element) {
      if (app.root.contains(rt)) {
        dest = rt;
      } else {
        __DEV__ &&
          warn(`rz-render: render target is outside the app root; ignoring.`, rt);
      }
    }

    if (dest) {
      dest.append(...roots);
      target = dest;
    }

    const teardown = () => {
      for (const fn of cleanups) {
        try {
          fn();
        } catch (error) {
          __DEV__ && warn('rz-render: instance cleanup failed.', error);
        }
      }
      for (const node of roots) node.remove();
      for (const root of elementRoots) unmarkRenderOwned(root);
    };

    return {
      key: instanceKey,
      item: plan.item,
      itemSig,
      indexSig,
      roots,
      target,
      teardown,
    };
  }

  /**
   * Positions an instance's root nodes immediately after `prev`, moving only
   * what's out of place. Returns the new trailing node.
   */
  function placeAfter(
    parent: ParentNode,
    roots: ChildNode[],
    prev: ChildNode,
  ): ChildNode {
    let ref = prev;
    for (const node of roots) {
      if (ref.nextSibling !== node) {
        parent.insertBefore(node, ref.nextSibling);
      }
      ref = node;
    }
    return ref;
  }

  function teardownAll() {
    for (const rec of records.values()) {
      rec.teardown();
    }
    records.clear();
  }

  /**
   * Diffs the incoming item plans against the live instances by key, then creates,
   * reuses, repositions, or removes instances so the DOM matches the new list.
   */
  function reconcile(normalized: NormalizedValue) {
    if (normalized.mode !== currentMode) {
      teardownAll();
      currentMode = normalized.mode;
    }

    const parent = template.parentNode;
    if (!parent) return;

    let prev: ChildNode = template;
    let missing = 0;
    let dups = 0;
    let firstDup: string | number | null = null;

    const onMissing = () => missing++;
    const seen = new Set<string | number>();

    for (const plan of normalized.items) {
      const instanceKey = keyFor(plan, normalized.mode, keyPath, onMissing);

      if (seen.has(instanceKey)) {
        dups++;
        if (firstDup === null) {
          firstDup = instanceKey;
        }
        continue;
      }
      seen.add(instanceKey);

      let rec = records.get(instanceKey);
      if (rec) {
        // Same key, new identity (e.g. refetched data, explicit rz-key): swap
        // the item so bound directives re-read without a rebuild.
        if (rec.item !== plan.item) {
          rec.item = plan.item;
          rec.itemSig(toItemProxy(plan.item));
        }
        if (rec.indexSig() !== plan.index) {
          rec.indexSig(plan.index);
        }
      } else {
        rec = buildInstance(plan, instanceKey);
        records.set(instanceKey, rec);
      }

      // Teleported instances live in a remote target, so don't position inline
      if (!rec.target) {
        prev = placeAfter(parent, rec.roots, prev);
      }
    }

    if (__DEV__) {
      if (missing > 0 && !keyWarned) {
        keyWarned = true;
        warn(
          `rz-key: '${keyPath}' could not be resolved on ${missing} item(s). Positional keys used.`,
        );
      }
      if (dups > 0 && !dupWarned) {
        dupWarned = true;
        warn(
          `rz-key: skipped ${dups} item(s) with duplicate '${keyPath}' values. First collision: '${firstDup}'.`,
        );
      }
    }

    for (const [k, rec] of records) {
      if (!seen.has(k)) {
        rec.teardown();
        records.delete(k);
      }
    }
  }

  const stop = effect(() => {
    // `source()` runs tracked so it subscribes to the source array/value.
    // `reconcile()` runs untracked so instance binding doesn't link to this effect.
    const normalized = normalize(source());
    untracked(() => reconcile(normalized));
  });

  return () => {
    stop();
    teardownAll();
  };
}
