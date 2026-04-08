import { Fx } from "@robelest/fx";
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
import { CrdtType, type FieldRef } from "@/shared/types";

type RefValue<TRef extends FieldRef> =
  TRef extends FieldRef<string, string, infer Value, string> ? Value : unknown;

interface BaseFieldHandle {
  subscribe(callback: () => void): () => void;
  dispose(): void;
}

export interface ProseHandle extends BaseFieldHandle {
  readonly kind: "prose";
  value(): ProseContent;
  text(): string;
}

export interface RegisterHandle<T = unknown> extends BaseFieldHandle {
  readonly kind: "register";
  value(): T;
}

export interface SetHandle<T = unknown[]> extends BaseFieldHandle {
  readonly kind: "set";
  value(): T;
}

export interface CounterHandle extends BaseFieldHandle {
  readonly kind: "counter";
  value(): number;
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
      await Fx.run(
        Fx.from({
          ok: () =>
            input.entry.runtime.getDocument(input.ref.table, input.ref.id),
          err: (error) => error as Error,
        }).pipe(
          Fx.tap((document) =>
            Fx.sync(() => {
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
            }),
          ),
          Fx.map(() => undefined as void),
        ),
      );
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
  ref: FieldRef<string, string, ProseContent, "prose">,
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
  await Fx.run(
    Fx.from({ ok: () => state.ready, err: (error) => error as Error }),
  );

  return {
    kind: "prose",
    value: () => cloneProseContent(state.currentValue),
    text: () =>
      state.currentText ?? proseContentToPlainText(state.currentValue),
    subscribe: (callback) => {
      state.listeners.add(callback);
      return () => state.listeners.delete(callback);
    },
    dispose: () => state.release(),
  };
}

export async function openRegister<
  TRef extends FieldRef<string, string, unknown, "register">,
>(client: ConvexClient, ref: TRef): Promise<RegisterHandle<RefValue<TRef>>> {
  const entry = requireEntry(client);
  const definition = requireDefinition(entry, ref.table);
  assertFieldType(definition, ref.field, CrdtType.Register);

  const state = createSharedFieldState<RefValue<TRef>>({
    entry,
    ref,
    kind: "register",
    emptyValue: undefined as RefValue<TRef>,
    read: (document) => ({ value: document?.[ref.field] as RefValue<TRef> }),
  });
  await Fx.run(
    Fx.from({ ok: () => state.ready, err: (error) => error as Error }),
  );

  return {
    kind: "register",
    value: () => state.currentValue,
    subscribe: (callback) => {
      state.listeners.add(callback);
      return () => state.listeners.delete(callback);
    },
    dispose: () => state.release(),
  };
}

export async function openSet<
  TRef extends FieldRef<string, string, unknown[], "set">,
>(client: ConvexClient, ref: TRef): Promise<SetHandle<RefValue<TRef>>> {
  const entry = requireEntry(client);
  const definition = requireDefinition(entry, ref.table);
  assertFieldType(definition, ref.field, CrdtType.Set);

  const state = createSharedFieldState<RefValue<TRef>>({
    entry,
    ref,
    kind: "set",
    emptyValue: [] as RefValue<TRef>,
    read: (document) => ({
      value: (() => {
        const fieldValue = document?.[ref.field];
        return Array.isArray(fieldValue)
          ? (Array.from(fieldValue) as RefValue<TRef>)
          : ([] as RefValue<TRef>);
      })(),
    }),
  });
  await Fx.run(
    Fx.from({ ok: () => state.ready, err: (error) => error as Error }),
  );

  return {
    kind: "set",
    value: () => [...state.currentValue] as RefValue<TRef>,
    subscribe: (callback) => {
      state.listeners.add(callback);
      return () => state.listeners.delete(callback);
    },
    dispose: () => state.release(),
  };
}

export async function openCounter(
  client: ConvexClient,
  ref: FieldRef<string, string, number, "counter">,
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
  await Fx.run(
    Fx.from({ ok: () => state.ready, err: (error) => error as Error }),
  );

  return {
    kind: "counter",
    value: () => state.currentValue,
    subscribe: (callback) => {
      state.listeners.add(callback);
      return () => state.listeners.delete(callback);
    },
    dispose: () => state.release(),
  };
}
