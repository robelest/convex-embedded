import type { CachedEntry, EmbeddedQueryCache } from "@/client/cache";

import type { EffectDescriptor } from "./derive";

export interface OptimisticTransitionUpdate {
  refName: string;
  args: unknown;
  value: unknown;
  priority?: "discrete" | "transition";
}

interface PlainObject {
  [key: string]: unknown;
}

function isPlainObject(value: unknown): value is PlainObject {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

function getId(value: unknown): string | null {
  if (!isPlainObject(value)) return null;
  const id = value._id;
  return typeof id === "string" ? id : null;
}

function applyPatchToDoc(
  doc: PlainObject,
  patch: Record<string, unknown>,
): PlainObject {
  return { ...doc, ...patch };
}

function transformValue(value: unknown, effect: EffectDescriptor): unknown {
  if (effect.kind === "patch" || effect.kind === "delete") {
    return transformForExistingId(value, effect);
  }
  // insert
  return undefined;
}

function transformForExistingId(
  value: unknown,
  effect: {
    kind: "patch" | "delete";
    id: string;
    patch?: Record<string, unknown>;
  },
): unknown {
  // Single document
  const id = getId(value);
  if (id !== null) {
    if (id !== effect.id) return undefined;
    if (effect.kind === "delete") return null;
    const patch = (effect as { patch?: Record<string, unknown> }).patch ?? {};
    return applyPatchToDoc(value as PlainObject, patch);
  }

  // Paginated page: { page: [...], isDone, continueCursor }
  if (isPlainObject(value) && Array.isArray(value.page)) {
    const page = value.page as unknown[];
    let touched = false;
    const nextPage: unknown[] = [];
    for (const item of page) {
      const itemId = getId(item);
      if (itemId === effect.id) {
        touched = true;
        if (effect.kind === "delete") {
          continue;
        }
        const patch =
          (effect as { patch?: Record<string, unknown> }).patch ?? {};
        nextPage.push(applyPatchToDoc(item as PlainObject, patch));
      } else {
        nextPage.push(item);
      }
    }
    if (!touched) return undefined;
    return { ...value, page: nextPage };
  }

  // Bare list
  if (Array.isArray(value)) {
    let touched = false;
    const next: unknown[] = [];
    for (const item of value) {
      const itemId = getId(item);
      if (itemId === effect.id) {
        touched = true;
        if (effect.kind === "delete") continue;
        const patch =
          (effect as { patch?: Record<string, unknown> }).patch ?? {};
        next.push(applyPatchToDoc(item as PlainObject, patch));
      } else {
        next.push(item);
      }
    }
    if (!touched) return undefined;
    return next;
  }

  return undefined;
}

function priorityForValue(value: unknown): "discrete" | "transition" {
  if (isPlainObject(value) && Array.isArray(value.page)) return "transition";
  if (Array.isArray(value)) return "transition";
  return "discrete";
}

export function effectToTransitions(
  effect: EffectDescriptor,
  cache: EmbeddedQueryCache,
): OptimisticTransitionUpdate[] {
  const updates: OptimisticTransitionUpdate[] = [];

  const targeted = cache.entriesByTable(effect.table);
  const source = targeted.length > 0 ? targeted : cache.entries();

  for (const record of source) {
    const tablesRead = cache.getTablesRead(record.refName, record.args);
    if (tablesRead && tablesRead.size > 0 && !tablesRead.has(effect.table)) {
      continue;
    }
    const next = transformValue(record.entry.value, effect);
    if (next === undefined) continue;
    updates.push({
      refName: record.refName,
      args: record.args,
      value: next,
      priority: priorityForValue(record.entry.value),
    });
  }

  return updates;
}

export function effectToTransitionsForEntries(
  effect: EffectDescriptor,
  entries: ReadonlyArray<{
    refName: string;
    args: unknown;
    entry: CachedEntry;
  }>,
): OptimisticTransitionUpdate[] {
  const updates: OptimisticTransitionUpdate[] = [];
  for (const entry of entries) {
    const next = transformValue(entry.entry.value, effect);
    if (next === undefined || next === null) continue;
    updates.push({
      refName: entry.refName,
      args: entry.args,
      value: next,
      priority: priorityForValue(entry.entry.value),
    });
  }
  return updates;
}
