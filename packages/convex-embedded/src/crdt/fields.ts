import type { ConvexClient } from "convex/browser";
import { convexToJson } from "convex/values";

import {
  getEmbeddedClientEntry,
  type EmbeddedClientEntry,
} from "@/client/entry";
import {
  cloneProseContent,
  createEmptyProseContent,
  type ProseContent,
  proseContentToPlainText,
} from "@/crdt/prose";
import type { Definition } from "@/shared/schema";
import { getCrdtType } from "@/shared/schema";
import { CrdtType } from "@/shared/types";

export interface FieldRef {
  table: string;
  id: string;
  field: string;
}

interface BaseFieldHandle {
  subscribe(callback: () => void): () => void;
  dispose(): void;
}

export interface ProseHandle extends BaseFieldHandle {
  readonly kind: "prose";
  getValue(): ProseContent;
  getText(): string;
}

export interface RegisterHandle<T = unknown> extends BaseFieldHandle {
  readonly kind: "register";
  getValue(): T | undefined;
}

export interface SetHandle<T = string> extends BaseFieldHandle {
  readonly kind: "set";
  getValue(): T[];
}

export interface CounterHandle extends BaseFieldHandle {
  readonly kind: "counter";
  getValue(): number;
}

type SharedFieldState<T> = {
  kind: "prose" | "register" | "set" | "counter";
  refCount: number;
  listeners: Set<() => void>;
  currentValue: T;
  currentText?: string;
  currentSignature: string;
  ready: Promise<void>;
  refresh(): Promise<void>;
  release(): void;
};

function serializeValue(value: unknown): string {
  try {
    return JSON.stringify(convexToJson(value as never));
  } catch {
    return JSON.stringify(value);
  }
}

function requireEntry(client: ConvexClient): EmbeddedClientEntry {
  const entry = getEmbeddedClientEntry(client);
  if (!entry) {
    throw new Error(
      "CRDT field handles require a client created by @robelest/convex-embedded.",
    );
  }
  return entry;
}

function requireDefinition(
  entry: EmbeddedClientEntry,
  table: string,
): Definition {
  const definition = entry.tableDefinitions.get(table);
  if (!definition) {
    throw new Error(
      `CRDT field handles require the embedded schema export; missing table definition for "${table}".`,
    );
  }
  return definition;
}

function assertFieldType(
  definition: Definition,
  field: string,
  expected: (typeof CrdtType)[keyof typeof CrdtType],
): void {
  const fieldDef = definition.shape[field];
  if (!fieldDef) {
    throw new Error(`Unknown CRDT field "${field}".`);
  }
  const actual = getCrdtType(fieldDef);
  if (actual !== expected) {
    throw new Error(`Field "${field}" is ${actual}, expected ${expected}.`);
  }
}

function createSharedFieldState<T>(input: {
  entry: EmbeddedClientEntry;
  ref: FieldRef;
  kind: SharedFieldState<T>["kind"];
  emptyValue: T;
  read: (document: Record<string, unknown> | null) => {
    value: T;
    text?: string;
  };
}): SharedFieldState<T> {
  const cacheKey = `${input.kind}:${input.ref.table}:${input.ref.id}:${input.ref.field}`;
  const existing = input.entry.fieldHandles.get(cacheKey) as
    | SharedFieldState<T>
    | undefined;
  if (existing) {
    existing.refCount += 1;
    return existing;
  }

  let disposed = false;
  let refreshing = false;
  let refreshQueued = false;
  const listeners = new Set<() => void>();

  const subscription = input.entry.runtime.subscribeTableWrites(
    input.ref.table,
    () => {
      void refresh();
    },
  );

  const refresh = async (): Promise<void> => {
    if (disposed) {
      return;
    }
    if (refreshing) {
      refreshQueued = true;
      return;
    }

    refreshing = true;
    try {
      const document = await input.entry.runtime.getDocument(
        input.ref.table,
        input.ref.id,
      );
      const next = input.read(document);
      const signature = `${serializeValue(next.value)}::${next.text ?? ""}`;
      if (signature !== state.currentSignature) {
        state.currentValue = next.value;
        state.currentText = next.text;
        state.currentSignature = signature;
        for (const listener of Array.from(listeners)) {
          listener();
        }
      }
    } finally {
      refreshing = false;
      if (refreshQueued) {
        refreshQueued = false;
        void refresh();
      }
    }
  };

  const state: SharedFieldState<T> = {
    kind: input.kind,
    refCount: 1,
    listeners,
    currentValue: input.emptyValue,
    currentSignature: serializeValue(input.emptyValue),
    ready: Promise.resolve(),
    refresh,
    release: () => {
      state.refCount -= 1;
      if (state.refCount > 0) {
        return;
      }
      disposed = true;
      subscription.unsubscribe();
      input.entry.fieldHandles.delete(cacheKey);
      listeners.clear();
    },
  };

  state.ready = refresh();
  input.entry.fieldHandles.set(cacheKey, state);
  return state;
}

export async function openProse(
  client: ConvexClient,
  ref: FieldRef,
): Promise<ProseHandle> {
  const entry = requireEntry(client);
  const definition = requireDefinition(entry, ref.table);
  assertFieldType(definition, ref.field, CrdtType.Prose);

  const state = createSharedFieldState<ProseContent>({
    entry,
    ref,
    kind: "prose",
    emptyValue: createEmptyProseContent(),
    read: (document) => {
      const value = cloneProseContent(document?.[ref.field]);
      return {
        value,
        text: proseContentToPlainText(value),
      };
    },
  });
  await state.ready;

  return {
    kind: "prose",
    getValue: () => cloneProseContent(state.currentValue),
    getText: () =>
      state.currentText ?? proseContentToPlainText(state.currentValue),
    subscribe: (callback) => {
      state.listeners.add(callback);
      return () => state.listeners.delete(callback);
    },
    dispose: () => state.release(),
  };
}

export async function openRegister<T = unknown>(
  client: ConvexClient,
  ref: FieldRef,
): Promise<RegisterHandle<T>> {
  const entry = requireEntry(client);
  const definition = requireDefinition(entry, ref.table);
  assertFieldType(definition, ref.field, CrdtType.Register);

  const state = createSharedFieldState<T | undefined>({
    entry,
    ref,
    kind: "register",
    emptyValue: undefined,
    read: (document) => ({ value: document?.[ref.field] as T | undefined }),
  });
  await state.ready;

  return {
    kind: "register",
    getValue: () => state.currentValue,
    subscribe: (callback) => {
      state.listeners.add(callback);
      return () => state.listeners.delete(callback);
    },
    dispose: () => state.release(),
  };
}

export async function openSet<T = string>(
  client: ConvexClient,
  ref: FieldRef,
): Promise<SetHandle<T>> {
  const entry = requireEntry(client);
  const definition = requireDefinition(entry, ref.table);
  assertFieldType(definition, ref.field, CrdtType.Set);

  const state = createSharedFieldState<T[]>({
    entry,
    ref,
    kind: "set",
    emptyValue: [],
    read: (document) => ({
      value: (() => {
        const fieldValue = document?.[ref.field];
        return Array.isArray(fieldValue) ? (Array.from(fieldValue) as T[]) : [];
      })(),
    }),
  });
  await state.ready;

  return {
    kind: "set",
    getValue: () => [...state.currentValue],
    subscribe: (callback) => {
      state.listeners.add(callback);
      return () => state.listeners.delete(callback);
    },
    dispose: () => state.release(),
  };
}

export async function openCounter(
  client: ConvexClient,
  ref: FieldRef,
): Promise<CounterHandle> {
  const entry = requireEntry(client);
  const definition = requireDefinition(entry, ref.table);
  assertFieldType(definition, ref.field, CrdtType.Counter);

  const state = createSharedFieldState<number>({
    entry,
    ref,
    kind: "counter",
    emptyValue: 0,
    read: (document) => ({
      value:
        typeof document?.[ref.field] === "number"
          ? (document[ref.field] as number)
          : 0,
    }),
  });
  await state.ready;

  return {
    kind: "counter",
    getValue: () => state.currentValue,
    subscribe: (callback) => {
      state.listeners.add(callback);
      return () => state.listeners.delete(callback);
    },
    dispose: () => state.release(),
  };
}
