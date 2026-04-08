import { Fx } from "@robelest/fx";
import { ConvexHttpClient } from "convex/browser";
import { convexToJson, type JSONValue } from "convex/values";

import {
  discoverRemoteMetadata,
  warnModuleLoadFailures,
} from "@/client/discovery";
import type { ConvexModule, ConvexModuleRegistry } from "@/kernel/modules";
import { normalizeModuleRegistry } from "@/kernel/modules";

type ReplicaDocument = Record<string, JSONValue>;

/**
 * Serializable embedded table data captured from a remote Convex deployment.
 *
 * A replica is the portable bootstrap artifact used by SSR flows: the server
 * builds it once, renders against an embedded runtime seeded with the same
 * data, then passes it to the browser client so first paint and first local
 * reads observe the same documents.
 *
 * @remarks
 * Treat the object as opaque application data. Consumers should pass it back
 * into `createEmbeddedRuntime(...)` or `createConvexClient(...)` rather than
 * mutating individual tables.
 *
 * @example
 * ```ts
 * const replica = await createReplica({
 *   modules,
 *   url: process.env.CONVEX_URL!,
 * });
 *
 * const runtime = createEmbeddedRuntime({ modules, schema, replica });
 * ```
 *
 * @see createReplica
 * @category Type
 */
export interface Replica {
  /** Replica schema version for forward-compatibility checks. */
  version: 1;

  /**
   * Active identity scope for identity-scoped embedded tables.
   *
   * `null` means the replica was built for anonymous data.
   */
  identityKey: string | null;

  /** Authoritative Convex JSON documents grouped by embedded table name. */
  tables: Record<string, ReplicaDocument[]>;
}

/**
 * Options for {@link createReplica}.
 *
 * @example
 * ```ts
 * const replica = await createReplica({
 *   modules,
 *   url: process.env.CONVEX_URL!,
 *   token,
 *   tables: ["tasks", "projects"],
 * });
 * ```
 *
 * @see createReplica
 * @category Configuration
 */
export interface CreateReplicaOptions {
  /** Lazy ESM registry keyed by canonical Convex module id. */
  modules: ConvexModuleRegistry;

  /** Remote Convex deployment URL used to read authoritative table data. */
  url: string;

  /** Optional JWT forwarded to the remote deployment for authenticated reads. */
  token?: string | null;

  /**
   * Optional identity scope attached to the resulting replica.
   *
   * Set this when the replica should seed identity-scoped embedded tables for
   * a specific authenticated user.
   */
  identityKey?: string | null;

  /**
   * Optional allowlist of embedded table names to include.
   *
   * When omitted, all discovered embedded tables are fetched.
   */
  tables?: readonly string[];
}

function normalizeReplicaDocuments(
  tableName: string,
  result: unknown,
): ReplicaDocument[] {
  if (!Array.isArray(result)) {
    throw new Error(
      `[convex-embedded] createReplica expected "${tableName}" to return an array of documents.`,
    );
  }

  return result.map((doc, index) => {
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
      throw new Error(
        `[convex-embedded] createReplica expected "${tableName}" row ${index} to be a document object.`,
      );
    }
    if (typeof (doc as { _id?: unknown })._id !== "string") {
      throw new Error(
        `[convex-embedded] createReplica expected "${tableName}" row ${index} to include a string _id.`,
      );
    }
    if (
      typeof (doc as { _creationTime?: unknown })._creationTime !== "number"
    ) {
      throw new Error(
        `[convex-embedded] createReplica expected "${tableName}" row ${index} to include a numeric _creationTime.`,
      );
    }
    const encoded = convexToJson(doc as never);
    if (!encoded || typeof encoded !== "object" || Array.isArray(encoded)) {
      throw new Error(
        `[convex-embedded] createReplica expected "${tableName}" row ${index} to encode to a document object.`,
      );
    }
    return encoded as ReplicaDocument;
  });
}

function pickReplicaTables(
  tables: Record<
    string,
    { query: string; resolveArgs?: () => Record<string, unknown> }
  >,
  requestedTables?: readonly string[],
): Record<
  string,
  { query: string; resolveArgs?: () => Record<string, unknown> }
> {
  if (!requestedTables || requestedTables.length === 0) {
    return tables;
  }

  const missing = requestedTables.filter((tableName) => !(tableName in tables));
  if (missing.length > 0) {
    throw new Error(
      `[convex-embedded] createReplica could not find embedded table metadata for: ${missing.join(", ")}`,
    );
  }

  return Object.fromEntries(
    requestedTables.map((tableName) => [tableName, tables[tableName]!]),
  );
}

/**
 * Build a replica from remote embedded table queries.
 *
 * The helper discovers embedded table metadata from the provided Convex module
 * registry, queries the corresponding remote list queries at a consistent
 * timestamp, validates the returned documents, and packages them into a single
 * serializable artifact for runtime or browser startup.
 *
 * @param options - Replica creation options including modules and remote URL.
 * @returns A serializable {@link Replica} suitable for SSR/bootstrap flows.
 *
 * @throws {Error} When no embedded tables can be discovered from `modules`.
 * @throws {Error} When `tables` names do not match discovered embedded tables.
 * @throws {Error} When a remote table query does not return valid Convex
 * documents with `_id` and `_creationTime`.
 *
 * @example
 * ```ts
 * const replica = await createReplica({
 *   modules,
 *   url: process.env.CONVEX_URL!,
 *   token,
 * });
 *
 * const client = createConvexClient({
 *   modules,
 *   schema,
 *   remote: { url: process.env.CONVEX_URL! },
 *   replica,
 * });
 * ```
 *
 * @see Replica
 * @see createEmbeddedRuntime
 * @category Factory
 */
export async function createReplica(
  options: CreateReplicaOptions,
): Promise<Replica> {
  const modules = normalizeModuleRegistry(
    options.modules as Record<string, () => Promise<ConvexModule>>,
  );
  return Fx.run(
    Fx.from({
      ok: () => discoverRemoteMetadata({ modules }),
      err: (error) => error as Error,
    }).pipe(
      Fx.map((discovered) => {
        if (!discovered) {
          throw new Error(
            "[convex-embedded] createReplica failed: module discovery returned no result. " +
              "This can happen if discovery was cancelled via shouldStop() or if no modules could be loaded.",
          );
        }
        return discovered;
      }),
      Fx.tap((discovered) =>
        Fx.sync(() => {
          warnModuleLoadFailures(discovered.moduleLoadFailures);
        }),
      ),
      Fx.chain((discovered) => {
        const selectedTables = pickReplicaTables(
          discovered.tables,
          options.tables,
        );
        const tableNames = Object.keys(selectedTables);
        if (tableNames.length === 0) {
          return Fx.fail(
            new Error(
              "[convex-embedded] createReplica found no embedded table metadata in the provided modules.",
            ),
          );
        }

        const remoteClient = new ConvexHttpClient(options.url, {
          auth: options.token ?? undefined,
          logger: false,
        });

        const tables: Replica["tables"] = {};
        return Fx.each(tableNames, (tableName) => {
          const table = selectedTables[tableName]!;
          const args = table.resolveArgs?.() ?? {};
          return Fx.from({
            ok: () => remoteClient.consistentQuery(table.query as any, args),
            err: (error) => error as Error,
          }).pipe(
            Fx.tap((result) =>
              Fx.sync(() => {
                tables[tableName] = normalizeReplicaDocuments(
                  tableName,
                  result,
                );
              }),
            ),
            Fx.map(() => undefined as void),
          );
        }).pipe(
          Fx.map(
            (): Replica => ({
              version: 1,
              identityKey: options.identityKey ?? null,
              tables,
            }),
          ),
        );
      }),
    ),
  );
}
