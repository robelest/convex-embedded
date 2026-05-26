/**
 * Remote discovery metadata captured from lazy Convex modules.
 *
 * The discovery pass extracts route modes, embedded-table bindings, and
 * storage upload URL metadata without executing any remote sync logic.
 * It is used by both live remote attachment and SSR preload flows.
 *
 * @internal
 */

import { asError } from "@/client/routing/refs";
import type { ConvexInput, ConvexModule } from "@/kernel/modules";
import { createLogger } from "@/shared/logger";
import { getRouteMode, type RouteMode } from "@/shared/route";

const log = createLogger("discovery");

export interface ModuleLoadFailure {
  path: string;
  error: Error;
}

export interface DiscoveryTable {
  resolve: string;
  schema?: unknown;
}

export interface DiscoveredRemoteMetadata {
  routeModes: Map<string, RouteMode>;
  tables: Record<string, DiscoveryTable>;
  moduleLoadFailures: ModuleLoadFailure[];
  uploadUrl?: string;
}

function createDiscoveryAccumulator(): DiscoveredRemoteMetadata {
  return {
    routeModes: new Map(),
    tables: {},
    moduleLoadFailures: [],
    uploadUrl: undefined,
  };
}

async function loadManifestTableSchema(input: {
  convex: ConvexInput;
  schemaModule?: string;
  schemaExport?: string;
}): Promise<unknown> {
  if (!input.schemaModule || !input.schemaExport) {
    return undefined;
  }
  const loader = input.convex.modules[input.schemaModule];
  if (!loader) {
    return undefined;
  }
  const mod = await loader();
  const exported = (mod as Record<string, unknown>)[input.schemaExport] as
    | { schema?: unknown }
    | undefined;
  return exported?.schema;
}

function collectTableDependencies(
  value: unknown,
  dependencies: Set<string>,
): void {
  if (!value || typeof value !== "object") {
    return;
  }

  const candidate = value as {
    kind?: unknown;
    tableName?: unknown;
    fields?: Record<string, unknown>;
    element?: unknown;
    members?: unknown[];
    shape?: Record<string, unknown>;
    validator?: unknown;
  };

  if (candidate.shape && typeof candidate.shape === "object") {
    for (const field of Object.values(candidate.shape)) {
      collectTableDependencies(field, dependencies);
    }
  }

  if (candidate.validator !== undefined) {
    collectTableDependencies(candidate.validator, dependencies);
  }

  switch (candidate.kind) {
    case "id":
      if (typeof candidate.tableName === "string") {
        dependencies.add(candidate.tableName);
      }
      return;
    case "array":
      collectTableDependencies(candidate.element, dependencies);
      return;
    case "union":
      if (Array.isArray(candidate.members)) {
        for (const member of candidate.members) {
          collectTableDependencies(member, dependencies);
        }
      }
      return;
    case "object":
      if (candidate.fields && typeof candidate.fields === "object") {
        for (const field of Object.values(candidate.fields)) {
          collectTableDependencies(field, dependencies);
        }
      }
      return;
  }
}

function sortDiscoveredTables<T extends DiscoveryTable>(
  tables: Record<string, T>,
): Record<string, T> {
  const tableNames = Object.keys(tables);
  const dependenciesByTable = new Map<string, Set<string>>();

  for (const tableName of tableNames) {
    const dependencies = new Set<string>();
    collectTableDependencies(tables[tableName]?.schema, dependencies);
    dependencies.delete(tableName);
    dependenciesByTable.set(
      tableName,
      new Set(
        [...dependencies].filter((dependency) =>
          tableNames.includes(dependency),
        ),
      ),
    );
  }

  const remaining = new Set(tableNames);
  const orderedNames: string[] = [];

  while (remaining.size > 0) {
    const ready = tableNames.filter((tableName) => {
      if (!remaining.has(tableName)) {
        return false;
      }

      return [...(dependenciesByTable.get(tableName) ?? [])].every(
        (dependency) => !remaining.has(dependency),
      );
    });

    if (ready.length === 0) {
      orderedNames.push(
        ...tableNames.filter((tableName) => remaining.has(tableName)),
      );
      break;
    }

    for (const tableName of ready) {
      remaining.delete(tableName);
      orderedNames.push(tableName);
    }
  }

  return Object.fromEntries(
    orderedNames.map((tableName) => [tableName, tables[tableName]!]),
  );
}

function scanModuleExports(
  moduleName: string,
  mod: ConvexModule,
  accumulator: DiscoveredRemoteMetadata,
): void {
  const REMOTE_META = Symbol.for("convex-embedded:remoteMeta");
  const STORAGE_UPLOAD_URL_META = Symbol.for(
    "convex-embedded:storageUploadUrlMeta",
  );
  let syncMetaTagged = false;

  for (const [exportName, exportValue] of Object.entries(mod)) {
    if (
      !exportValue ||
      (typeof exportValue !== "object" && typeof exportValue !== "function")
    ) {
      continue;
    }

    const routeMode = getRouteMode(exportValue);
    if (routeMode !== null) {
      accumulator.routeModes.set(`${moduleName}:${exportName}`, routeMode);
    }

    const exportMeta = exportValue as Record<symbol, unknown>;

    const meta = exportMeta[REMOTE_META] as
      | {
          __brand: string;
          table: string;
          schema: unknown;
          resolveExport: string;
        }
      | undefined;
    if (
      !syncMetaTagged &&
      meta &&
      meta.__brand === "convex-embedded:remoteMeta"
    ) {
      syncMetaTagged = true;
      accumulator.tables[meta.table] = {
        resolve: `${moduleName}:${meta.resolveExport}`,
        schema: meta.schema,
      };
    }

    const storageUploadUrlMeta = exportMeta[STORAGE_UPLOAD_URL_META] as
      | { __brand: string }
      | undefined;
    if (
      accumulator.uploadUrl === undefined &&
      ((storageUploadUrlMeta &&
        storageUploadUrlMeta.__brand ===
          "convex-embedded:storageUploadUrlMeta") ||
        exportName === "generateUploadUrl")
    ) {
      accumulator.uploadUrl = `${moduleName}:${exportName}`;
    }
  }
}

/**
 * Discover remote routing and embedded-table metadata from a module registry.
 *
 * @param input - Discovery options including the lazy module registry.
 * @param input.modules - Canonical Convex module registry to inspect.
 * @param input.shouldStop - Optional cancellation probe used during discovery.
 * @returns Collected remote metadata, or `null` when discovery was cancelled.
 *
 * @see warnModuleLoadFailures
 */
export async function discoverRemoteMetadata(input: {
  convex: ConvexInput;
  shouldStop?: () => boolean;
}): Promise<DiscoveredRemoteMetadata | null> {
  const manifest = input.convex.manifest?.remote;
  if (manifest) {
    const tableEntries = await Promise.all(
      Object.entries(manifest.tables).map(
        async ([tableName, table]) =>
          [
            tableName,
            {
              resolve: table.resolve,
              schema: await loadManifestTableSchema({
                convex: input.convex,
                schemaModule: table.schemaModule,
                schemaExport: table.schemaExport,
              }),
            },
          ] as const,
      ),
    );

    return {
      routeModes: new Map(Object.entries(manifest.routeModes ?? {})),
      tables: sortDiscoveredTables(Object.fromEntries(tableEntries)),
      moduleLoadFailures: [],
      uploadUrl: manifest.uploadUrl,
    };
  }

  const accumulator = createDiscoveryAccumulator();

  for (const [moduleName, loader] of Object.entries(input.convex.modules)) {
    if (
      input.shouldStop?.() ||
      moduleName === "_generated" ||
      moduleName.startsWith("_generated/")
    ) {
      continue;
    }

    try {
      const mod = await loader();
      if (!input.shouldStop?.()) {
        scanModuleExports(moduleName, mod, accumulator);
      }
    } catch (err) {
      accumulator.moduleLoadFailures.push({
        path: moduleName,
        error: asError(err),
      });
    }
  }

  if (input.shouldStop?.()) {
    return null;
  }

  return {
    ...accumulator,
    tables: sortDiscoveredTables(accumulator.tables),
  };
}

/**
 * Emit a single warning summarizing module discovery failures.
 *
 * Discovery is intentionally best-effort so that a single broken module does
 * not prevent unrelated embedded tables from bootstrapping.
 *
 * @param failures - Per-module load failures captured during discovery.
 */
export function warnModuleLoadFailures(failures: ModuleLoadFailure[]): void {
  if (failures.length === 0) {
    return;
  }

  const skipped = failures.map(({ path }) => path).join(", ");
  const [firstFailure] = failures;
  log.warn(
    `${failures.length} module(s) failed to load during remote discovery and were skipped: ${skipped}`,
    firstFailure?.error,
  );
}
