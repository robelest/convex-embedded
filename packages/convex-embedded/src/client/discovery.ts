import { getRouteMode, type RouteMode } from "@/client/routing/metadata";
import { asError } from "@/client/routing/refs";
import type { ConvexModule } from "@/kernel/modules";

export interface ModuleLoadFailure {
  path: string;
  error: Error;
}

export interface DiscoveryTable {
  resolve: string;
  query: string;
  resolveArgs?: () => Record<string, unknown>;
  schema?: unknown;
}

export interface DiscoveredRemoteMetadata {
  routeModes: Map<string, RouteMode>;
  tables: Record<string, DiscoveryTable>;
  moduleLoadFailures: ModuleLoadFailure[];
}

function createDiscoveryAccumulator(): DiscoveredRemoteMetadata {
  return {
    routeModes: new Map(),
    tables: {},
    moduleLoadFailures: [],
  };
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
  const RESOLVE_QUERY_META = Symbol.for("convex-embedded:resolveQueryMeta");
  let syncMetaTagged = false;

  for (const [exportName, exportValue] of Object.entries(
    mod as Record<string, any>,
  )) {
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

    const meta = exportValue[REMOTE_META];
    if (
      !syncMetaTagged &&
      meta &&
      meta.__brand === "convex-embedded:remoteMeta"
    ) {
      syncMetaTagged = true;
      accumulator.tables[meta.table] = {
        resolve: `${moduleName}:${meta.resolveExport}`,
        query: meta.listExport
          ? `${moduleName}:${meta.listExport}`
          : `${moduleName}:list`,
        schema: meta.schema,
      };
    }

    const resolveQueryMeta = exportValue[RESOLVE_QUERY_META];
    if (
      resolveQueryMeta &&
      resolveQueryMeta.__brand === "convex-embedded:resolveQueryMeta"
    ) {
      accumulator.tables[resolveQueryMeta.table] = {
        ...(accumulator.tables[resolveQueryMeta.table] ?? {
          resolve: `${moduleName}:bind`,
          query: `${moduleName}:list`,
          schema: undefined,
        }),
        query: `${moduleName}:${exportName}`,
        resolveArgs: resolveQueryMeta.getArgs,
      };
    }
  }
}

export async function discoverRemoteMetadata(input: {
  modules: Record<string, () => Promise<ConvexModule>>;
  shouldStop?: () => boolean;
}): Promise<DiscoveredRemoteMetadata | null> {
  const accumulator = createDiscoveryAccumulator();

  for (const [moduleName, loader] of Object.entries(input.modules)) {
    if (
      input.shouldStop?.() ||
      moduleName === "_generated" ||
      moduleName.startsWith("_generated/")
    ) {
      continue;
    }

    try {
      const mod = await loader();
      if (input.shouldStop?.()) {
        return null;
      }
      scanModuleExports(moduleName, mod, accumulator);
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

export function warnModuleLoadFailures(failures: ModuleLoadFailure[]): void {
  if (failures.length === 0) {
    return;
  }

  const skipped = failures.map(({ path }) => path).join(", ");
  const [firstFailure] = failures;
  console.warn(
    `[convex-embedded] ${failures.length} module(s) failed to load during remote discovery and were skipped: ${skipped}`,
    firstFailure?.error,
  );
}
