import type { ConvexClient } from "convex/browser";

import type { EmbeddedRuntime } from "@/runtime/embedded";
import type { Definition } from "@/shared/schema";

export interface EmbeddedClientEntry {
  runtime: EmbeddedRuntime;
  tableDefinitions: Map<string, Definition>;
  fieldHandles: Map<string, unknown>;
}

const EMBEDDED_CLIENT_ENTRIES = Symbol.for(
  "convex-embedded:client/entry:embeddedClientEntries",
);

type EntryGlobal = typeof globalThis & {
  [EMBEDDED_CLIENT_ENTRIES]?: WeakMap<ConvexClient, EmbeddedClientEntry>;
};

function getEmbeddedClientEntriesStore() {
  const globalState = globalThis as EntryGlobal;
  globalState[EMBEDDED_CLIENT_ENTRIES] ??= new WeakMap<
    ConvexClient,
    EmbeddedClientEntry
  >();
  return globalState[EMBEDDED_CLIENT_ENTRIES];
}

export function registerEmbeddedClientEntry(
  client: ConvexClient,
  entry: EmbeddedClientEntry,
): void {
  getEmbeddedClientEntriesStore().set(client, entry);
}

export function getEmbeddedClientEntry(
  client: ConvexClient,
): EmbeddedClientEntry | undefined {
  return getEmbeddedClientEntriesStore().get(client);
}

export function deleteEmbeddedClientEntry(client: ConvexClient): void {
  getEmbeddedClientEntriesStore().delete(client);
}

export function extractEmbeddedTableDefinitions(
  schemaExport: unknown,
): Map<string, Definition> {
  const definitions = new Map<string, Definition>();
  if (!schemaExport || typeof schemaExport !== "object") {
    return definitions;
  }

  const tables = (schemaExport as { tables?: Record<string, unknown> }).tables;
  if (!tables || typeof tables !== "object") {
    return definitions;
  }

  for (const [tableName, tableDef] of Object.entries(tables)) {
    const schemaDef =
      tableDef && typeof tableDef === "object"
        ? (tableDef as { schema?: Definition }).schema
        : undefined;
    if (schemaDef) {
      definitions.set(tableName, schemaDef);
    }
  }

  return definitions;
}
