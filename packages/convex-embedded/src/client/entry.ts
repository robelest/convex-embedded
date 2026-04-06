import type { ConvexClient } from "convex/browser";

import type { EmbeddedRuntime } from "@/runtime/embedded";
import type { Definition } from "@/shared/schema";

export interface EmbeddedClientEntry {
  runtime: EmbeddedRuntime;
  tableDefinitions: Map<string, Definition>;
  fieldHandles: Map<string, unknown>;
}

const embeddedClientEntries = new WeakMap<ConvexClient, EmbeddedClientEntry>();

export function registerEmbeddedClientEntry(
  client: ConvexClient,
  entry: EmbeddedClientEntry,
): void {
  embeddedClientEntries.set(client, entry);
}

export function getEmbeddedClientEntry(
  client: ConvexClient,
): EmbeddedClientEntry | undefined {
  return embeddedClientEntries.get(client);
}

export function deleteEmbeddedClientEntry(client: ConvexClient): void {
  embeddedClientEntries.delete(client);
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
