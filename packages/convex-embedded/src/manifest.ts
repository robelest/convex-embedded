import { readFile } from "node:fs/promises";
import path from "node:path";

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

export function normalizePath(value: string): string {
  return value.split(path.sep).join("/");
}

function sanitizeModuleId(value: string): string {
  return value.replace(/[.-]/g, "_");
}

export function toModuleId(root: string, filePath: string): string {
  const relative = normalizePath(path.relative(root, filePath));
  return sanitizeModuleId(relative.replace(/\.[^.]+$/, ""));
}

export function toImportPath(fromFile: string, targetFile: string): string {
  const relative = normalizePath(
    path.relative(path.dirname(fromFile), targetFile),
  ).replace(/\.[^.]+$/, "");
  return relative.startsWith(".") ? relative : `./${relative}`;
}

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

export function collectImports(
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

export async function resolveEmbeddedTableName(input: {
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

export async function collectRemoteManifest(input: {
  convexRoot: string;
  moduleId: string;
  source: string;
}): Promise<GeneratedRemoteManifest> {
  const routeModes: Record<string, "local" | "remote"> = {};
  const tables: GeneratedRemoteManifest["tables"] = {};
  let uploadUrl: string | undefined;
  const imports = collectImports(input.moduleId, input.source);

  const bindMatch = input.source.match(
    /export\s+const\s+bind\s*=\s*bindTable\s*\(\s*(\w+)\s*(?:,|\))/,
  );
  if (bindMatch) {
    const tableBinding = bindMatch[1]!;
    const imported = imports.get(tableBinding);
    const tableName =
      (await resolveEmbeddedTableName({
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

export interface RegistryEntry {
  /** Path used to derive the module id (always the original file). */
  originalFile: string;
  /** Path the dynamic import points at — either the original or a stripped companion. */
  importFile: string;
}

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
      const importFile =
        typeof entry === "string" ? entry : entry.importFile;
      const moduleId = toModuleId(input.convexDir, originalFile);
      const importPath = toImportPath(input.outFile, importFile);
      return `    ${JSON.stringify(moduleId)}: () => import(${JSON.stringify(importPath)}),`;
    })
    .join("\n");

  const routeModes = JSON.stringify(input.manifest.routeModes, null, 2).replace(
    /^/gm,
    "      ",
  );
  const tables = JSON.stringify(input.manifest.tables, null, 2).replace(
    /^/gm,
    "      ",
  );
  const uploadUrl = input.manifest.uploadUrl
    ? `,\n      uploadUrl: ${JSON.stringify(input.manifest.uploadUrl)}`
    : "";

  return `import type { ConvexInput } from "@robelest/convex-embedded";

export const convex: ConvexInput = {
  modules: {
${imports}
  },
  manifest: {
    remote: {
      routeModes: ${routeModes.trimStart()},
      tables: ${tables.trimStart()}${uploadUrl}
    }
  }
};
`;
}
