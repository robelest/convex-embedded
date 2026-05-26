/**
 * Build-time helpers consumed by framework adapters to produce the
 * embedded module registry. The runtime side reads the resulting
 * `manifest.remote` field from the generated file at startup; nothing
 * here is meant for direct app consumption.
 *
 * @packageDocumentation
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Build-time metadata captured by the codegen analyzer and written
 * into the generated registry's `manifest.remote` field. The runtime
 * uses this at startup to decide how to route function references
 * without having to load every module.
 *
 * @public
 */
export type GeneratedRemoteManifest = {
  routeModes: Record<string, "local" | "remote">;
  tables: Record<
    string,
    {
      resolve: string;
      schemaModule?: string;
      schemaExport?: string;
    }
  >;
  uploadUrl?: string;
};

/** @internal — codegen-internal path normalization helper. */
export function normalizePath(value: string): string {
  return value.split(path.sep).join("/");
}

function sanitizeModuleId(value: string): string {
  return value.replace(/[.-]/g, "_");
}

/**
 * Convert a filesystem path under `root` into the canonical Convex
 * module id (slash-separated, no extension, dots/dashes sanitized).
 *
 * @internal
 */
export function toModuleId(root: string, filePath: string): string {
  const relative = normalizePath(path.relative(root, filePath));
  return sanitizeModuleId(relative.replace(/\.[^.]+$/, ""));
}

/**
 * Compute the relative ES-module specifier `fromFile` should use to
 * import `targetFile`, including a leading `./` for in-tree paths and
 * the trailing extension stripped.
 *
 * @internal
 */
export function toImportPath(fromFile: string, targetFile: string): string {
  const relative = normalizePath(
    path.relative(path.dirname(fromFile), targetFile),
  ).replace(/\.[^.]+$/, "");
  return relative.startsWith(".") ? relative : `./${relative}`;
}

function objectKey(value: string): string {
  return /^[$A-Z_a-z][$\w]*$/.test(value) ? value : JSON.stringify(value);
}

function renderRouteModes(
  routeModes: GeneratedRemoteManifest["routeModes"],
): string {
  const entries = Object.entries(routeModes);
  if (entries.length === 0) return "{}";
  return `{
${entries
  .map(([key, value]) => `        ${objectKey(key)}: ${JSON.stringify(value)},`)
  .join("\n")}
      }`;
}

function renderTables(tables: GeneratedRemoteManifest["tables"]): string {
  const entries = Object.entries(tables);
  if (entries.length === 0) return "{}";
  return `{
${entries
  .map(([tableName, table]) => {
    const schemaModule = table.schemaModule
      ? `\n          schemaModule: ${JSON.stringify(table.schemaModule)},`
      : "";
    const schemaExport = table.schemaExport
      ? `\n          schemaExport: ${JSON.stringify(table.schemaExport)},`
      : "";
    return `        ${objectKey(tableName)}: {
          resolve: ${JSON.stringify(table.resolve)},${schemaModule}${schemaExport}
        },`;
  })
  .join("\n")}
      }`;
}

/** @internal — codegen-internal module-id resolution helper. */
export function canonicalizeRelativeModuleId(
  currentModuleId: string,
  importPath: string,
): string {
  return sanitizeModuleId(
    normalizePath(
      path.posix
        .normalize(
          path.posix.join(path.posix.dirname(currentModuleId), importPath),
        )
        .replace(/\.[^.]+$/, ""),
    ).replace(/^\.\//, ""),
  );
}

/** @internal — codegen-internal import-statement scanner. */
export function extractImports(
  currentModuleId: string,
  source: string,
): Map<string, { moduleId: string; exportName: string }> {
  const imports = new Map<string, { moduleId: string; exportName: string }>();

  for (const match of source.matchAll(
    /import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g,
  )) {
    const specifiers = match[1] ?? "";
    const importPath = match[2] ?? "";
    if (!importPath.startsWith(".")) {
      continue;
    }

    const moduleId = canonicalizeRelativeModuleId(currentModuleId, importPath);

    for (const specifier of specifiers
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)) {
      const aliasMatch = specifier.match(/^(\w+)\s+as\s+(\w+)$/);
      if (aliasMatch) {
        imports.set(aliasMatch[2]!, {
          moduleId,
          exportName: aliasMatch[1]!,
        });
      } else {
        imports.set(specifier, { moduleId, exportName: specifier });
      }
    }
  }

  return imports;
}

/** @internal — codegen-internal table-name resolver for `bindTable()`. */
export async function getEmbeddedTableName(input: {
  convexRoot: string;
  schemaModule?: string;
  schemaExport?: string;
}): Promise<string | undefined> {
  if (!input.schemaModule || !input.schemaExport) {
    return undefined;
  }
  const schemaPath = path.join(input.convexRoot, `${input.schemaModule}.ts`);
  try {
    const source = await readFile(schemaPath, "utf8");
    const match = source.match(
      new RegExp(
        `export\\s+const\\s+${input.schemaExport}\\s*=\\s*embeddedTable\\s*\\(\\s*["']([^"']+)["']`,
      ),
    );
    return match?.[1];
  } catch {
    return undefined;
  }
}

/**
 * Scan a single user module's source for the metadata the runtime
 * cares about: per-export `localOnly()` / `remoteOnly()` route modes,
 * `bindTable()` table bindings, and `storageUploadUrl()` markers.
 * Used by the codegen orchestrator; not for direct app use.
 *
 * @internal
 */
export async function fetchRemoteManifest(input: {
  convexRoot: string;
  moduleId: string;
  source: string;
}): Promise<GeneratedRemoteManifest> {
  const routeModes: Record<string, "local" | "remote"> = {};
  const tables: GeneratedRemoteManifest["tables"] = {};
  let uploadUrl: string | undefined;
  const imports = extractImports(input.moduleId, input.source);

  const bindMatch = input.source.match(
    /export\s+const\s+bind\s*=\s*bindTable\s*\(\s*(\w+)\s*(?:,|\))/,
  );
  if (bindMatch) {
    const tableBinding = bindMatch[1]!;
    const imported = imports.get(tableBinding);
    const tableName =
      (await getEmbeddedTableName({
        convexRoot: input.convexRoot,
        schemaModule: imported?.moduleId,
        schemaExport: imported?.exportName,
      })) ??
      imported?.exportName ??
      input.moduleId.split("/").pop() ??
      input.moduleId;
    tables[tableName] = {
      resolve: `${input.moduleId}:bind`,
      schemaModule: imported?.moduleId,
      schemaExport: imported?.exportName,
    };
  }

  for (const match of input.source.matchAll(
    /export\s+const\s+(\w+)\s*=\s*(localOnly|remoteOnly)\s*\(/g,
  )) {
    const exportName = match[1];
    const mode = match[2] === "localOnly" ? "local" : "remote";
    routeModes[`${input.moduleId}:${exportName}`] = mode;
  }

  for (const match of input.source.matchAll(
    /export\s+const\s+(\w+)\s*=\s*storageUploadUrl\s*\(/g,
  )) {
    uploadUrl ??= `${input.moduleId}:${match[1]}`;
  }
  if (!uploadUrl && /export\s+const\s+generateUploadUrl\b/.test(input.source)) {
    uploadUrl = `${input.moduleId}:generateUploadUrl`;
  }

  return { routeModes, tables, uploadUrl };
}

/**
 * One entry in the input array passed to {@link renderGeneratedFile}.
 * Lets the codegen distinguish the file used for module-id derivation
 * (always the original under `convex/`) from the file the dynamic
 * import points at (either the original or a stripped companion under
 * `_generated/embedded/`).
 *
 * @internal
 */
export interface RegistryEntry {
  /** Path used to derive the module id (always the original file). */
  originalFile: string;
  /** Path the dynamic import points at — either the original or a stripped companion. */
  importFile: string;
}

/**
 * Render the generated `_generated/embedded.ts` source. Emits the
 * dynamic-import registry plus the `manifest.remote` block; the
 * runtime imports both at startup.
 *
 * @internal
 */
export function renderGeneratedFile(input: {
  outFile: string;
  moduleFiles: ReadonlyArray<string | RegistryEntry>;
  convexDir: string;
  manifest: GeneratedRemoteManifest;
}): string {
  const imports = input.moduleFiles
    .map((entry) => {
      const originalFile =
        typeof entry === "string" ? entry : entry.originalFile;
      const importFile = typeof entry === "string" ? entry : entry.importFile;
      const moduleId = toModuleId(input.convexDir, originalFile);
      const importPath = toImportPath(input.outFile, importFile);
      return `    ${objectKey(moduleId)}: () => import(${JSON.stringify(importPath)}),`;
    })
    .join("\n");

  const routeModes = renderRouteModes(input.manifest.routeModes);
  const tables = renderTables(input.manifest.tables);
  const uploadUrl = input.manifest.uploadUrl
    ? `\n      uploadUrl: ${JSON.stringify(input.manifest.uploadUrl)},`
    : "";

  return `import type { ConvexInput } from "@robelest/convex-embedded";

export const convex: ConvexInput = {
  modules: {
${imports}
  },
  manifest: {
    remote: {
      routeModes: ${routeModes},
      tables: ${tables},${uploadUrl}
    },
  },
};
`;
}
