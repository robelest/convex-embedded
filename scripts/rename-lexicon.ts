import path from "node:path";
/**
 * Type-aware lexicon codemod.
 *
 * Each family is one named batch of renames. Run with:
 *   pnpm dlx tsx scripts/rename-lexicon.ts --family <N> [--dry-run]
 *   pnpm dlx tsx scripts/rename-lexicon.ts --list
 *
 * The codemod loads every .ts/.tsx in the monorepo (packages, tests, demos,
 * convex/, benchmarks/, scripts/, docs/) into a single ts-morph Project, finds
 * each old identifier at its declaration site, and renames it via the
 * TypeScript language service so every reference updates project-wide.
 *
 * ts-morph rename does NOT touch string literals — after running, sweep with:
 *   git grep -nE '\b<oldName>\b'
 * to verify nothing references the old name as a string.
 */
import { fileURLToPath } from "node:url";

import { Project } from "ts-morph";

interface RenameFamily {
  readonly id: number;
  readonly name: string;
  readonly renames: ReadonlyArray<readonly [string, string]>;
}

const FAMILIES: ReadonlyArray<RenameFamily> = [
  {
    id: 2,
    name: "collect→gather/extract (reserve `collect` for the Convex query terminal)",
    renames: [
      ["collectCandidateIds", "gatherCandidateIds"],
      ["collectCandidateStorageIds", "gatherCandidateStorageIds"],
      ["collectExportedMetrics", "gatherExportedMetrics"],
      ["collectFilterClauseGroups", "gatherFilterClauseGroups"],
      ["collectFilterClauses", "gatherFilterClauses"],
      ["collectImports", "extractImports"],
      ["collectMissingReferences", "gatherMissingReferences"],
      ["collectReferencedTables", "gatherReferencedTables"],
      ["collectRelevantTokens", "gatherRelevantTokens"],
      ["collectRemoteManifest", "fetchRemoteManifest"],
      ["collectTableDependencies", "gatherTableDependencies"],
      ["collectText", "extractText"],
      ["collectTopLevelBindings", "extractTopLevelBindings"],
      ["collectTransferables", "gatherTransferables"],
      [
        "collectUnmappedStorageDependencies",
        "gatherUnmappedStorageDependencies",
      ],
      ["collectDocs", "readDocs"],
      ["collectRows", "readRows"],
    ],
  },
  {
    id: 3,
    name: "writes: put/persist/upsert/update → store/write/insert/apply (Convex-aligned)",
    renames: [
      ["putBlob", "storeBlob"],
      ["putDocument", "writeDocument"],
      ["persistEntry", "writeEntry"],
      ["persistResolveMetadata", "writeResolveMetadata"],
      ["upsert", "write"],
      ["upsertSideTableEntryStatements", "buildSideTableWriteStatements"],
      ["updateRegistry", "applyIndexDefinitions"],
    ],
  },
  {
    id: 4,
    name: "removal: remove* → delete* for records; keep `remove` only for detach",
    renames: [
      ["removeDocument", "deleteDocument"],
      [
        "removeDocumentFromSearchIndexState",
        "deleteDocumentFromSearchIndexState",
      ],
      [
        "removeDocumentFromVectorIndexState",
        "deleteDocumentFromVectorIndexState",
      ],
      ["removeSession", "deleteSession"],
      ["removeLexiconTerm", "deleteLexiconTerm"],
      ["removeSocketFromSession", "detachSocketFromSession"],
    ],
  },
  {
    id: 5,
    name: "construction: clarify create (stateful factory) vs build (pure data assembly)",
    renames: [
      ["buildLogger", "createMigrationLogger"],
      ["makeResult", "buildResult"],
      ["makeRow", "buildRow"],
      ["makeScopeKey", "buildScopeKey"],
      ["makeComparable", "toComparable"],
    ],
  },
  {
    id: 6,
    name: "retrieval singletons: find/lookup → get/gather",
    renames: [
      ["findRemoteOnlyLocalNames", "gatherRemoteOnlyLocalNames"],
      ["lookupExplicitOptimistic", "getExplicitOptimistic"],
    ],
  },
];

function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function loadProject(): Project {
  const root = repoRoot();
  const project = new Project({
    tsConfigFilePath: `${root}/packages/convex-embedded/tsconfig.json`,
    skipAddingFilesFromTsConfig: false,
    compilerOptions: { allowJs: false, noEmit: true },
  });
  project.addSourceFilesAtPaths([
    `${root}/packages/convex-embedded/tests/**/*.{ts,tsx}`,
    `${root}/tests/**/*.{ts,tsx}`,
    `${root}/benchmarks/**/*.{ts,tsx}`,
    `${root}/convex/**/*.{ts,tsx}`,
    `${root}/demos/svelte/src/**/*.{ts,tsx}`,
    `${root}/demos/expo/src/**/*.{ts,tsx}`,
    `${root}/scripts/**/*.{ts,tsx}`,
  ]);
  return project;
}

function findDeclarations(
  project: Project,
  oldName: string,
): Array<{ filePath: string; node: import("ts-morph").Node }> {
  const declarations: Array<{
    filePath: string;
    node: import("ts-morph").Node;
  }> = [];
  for (const file of project.getSourceFiles()) {
    if (file.getFilePath().includes("/node_modules/")) continue;
    if (file.getFilePath().includes("/_generated/")) continue;
    if (file.getFilePath().includes("/dist/")) continue;

    const fn = file.getFunction(oldName);
    if (fn) {
      declarations.push({ filePath: file.getFilePath(), node: fn });
      continue;
    }
    const variable = file.getVariableDeclaration(oldName);
    if (variable) {
      declarations.push({ filePath: file.getFilePath(), node: variable });
      continue;
    }
    const cls = file.getClass(oldName);
    if (cls) {
      declarations.push({ filePath: file.getFilePath(), node: cls });
      continue;
    }
    const iface = file.getInterface(oldName);
    if (iface) {
      declarations.push({ filePath: file.getFilePath(), node: iface });
      continue;
    }
    const typeAlias = file.getTypeAlias(oldName);
    if (typeAlias) {
      declarations.push({ filePath: file.getFilePath(), node: typeAlias });
      continue;
    }
    for (const cls2 of file.getClasses()) {
      const method = cls2.getMethod(oldName);
      if (method) {
        declarations.push({ filePath: file.getFilePath(), node: method });
        break;
      }
    }
    for (const iface2 of file.getInterfaces()) {
      const method = iface2.getMethod(oldName);
      if (method) {
        declarations.push({ filePath: file.getFilePath(), node: method });
        break;
      }
      const prop = iface2.getProperty(oldName);
      if (prop) {
        declarations.push({ filePath: file.getFilePath(), node: prop });
        break;
      }
    }
  }
  return declarations;
}

interface ApplyOptions {
  readonly dryRun: boolean;
}

async function applyFamily(
  family: RenameFamily,
  opts: ApplyOptions,
): Promise<void> {
  const root = repoRoot();
  process.stdout.write(`\nFamily #${family.id} — ${family.name}\n`);
  process.stdout.write(`Loading project...\n`);
  const project = loadProject();
  process.stdout.write(
    `  ${project.getSourceFiles().length} source files loaded.\n\n`,
  );

  let renamedCount = 0;
  let missingCount = 0;
  const ambiguous: string[] = [];

  for (const [oldName, newName] of family.renames) {
    const decls = findDeclarations(project, oldName);
    if (decls.length === 0) {
      process.stdout.write(
        `  ${oldName} → ${newName}: (no declaration found)\n`,
      );
      missingCount++;
      continue;
    }
    if (decls.length > 1) {
      process.stdout.write(
        `  ${oldName} → ${newName}: AMBIGUOUS — declared in ${decls.length} files:\n`,
      );
      for (const d of decls) {
        process.stdout.write(`      ${path.relative(root, d.filePath)}\n`);
      }
      ambiguous.push(oldName);
      continue;
    }
    const decl = decls[0]!;
    const declAny = decl.node as unknown as { rename: (n: string) => void };
    declAny.rename(newName);
    process.stdout.write(
      `  ${oldName} → ${newName} (decl: ${path.relative(root, decl.filePath)})\n`,
    );
    renamedCount++;
  }

  process.stdout.write(
    `\n  Renamed: ${renamedCount}, missing: ${missingCount}, ambiguous: ${ambiguous.length}\n`,
  );
  if (ambiguous.length > 0) {
    process.stdout.write(
      `\n  Ambiguous symbols were NOT renamed (resolve manually):\n    ${ambiguous.join(", ")}\n`,
    );
  }

  if (opts.dryRun) {
    process.stdout.write(`\n  --dry-run: not saving.\n`);
    return;
  }
  process.stdout.write(`\n  Saving...\n`);
  await project.save();
  process.stdout.write(`  Done.\n`);
}

function listFamilies(): void {
  process.stdout.write(`\nAvailable families:\n\n`);
  for (const f of FAMILIES) {
    process.stdout.write(`  #${f.id} ${f.name}\n`);
    process.stdout.write(`        ${f.renames.length} renames\n`);
  }
  process.stdout.write(`\n`);
}

function parseArgs(argv: string[]): {
  family: number | null;
  list: boolean;
  dryRun: boolean;
} {
  let family: number | null = null;
  let list = false;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--list") list = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--family") {
      const next = argv[i + 1];
      if (!next) throw new Error("--family requires an argument");
      family = Number.parseInt(next, 10);
      if (Number.isNaN(family)) {
        throw new Error(`--family expects a number, got "${next}"`);
      }
      i++;
    }
  }
  return { family, list, dryRun };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.list || (args.family === null && !args.list)) {
    listFamilies();
    if (args.family === null) {
      process.stdout.write(
        `Usage: tsx scripts/rename-lexicon.ts --family <N> [--dry-run]\n`,
      );
    }
    return;
  }
  const family = FAMILIES.find((f) => f.id === args.family);
  if (!family) {
    throw new Error(`Family ${args.family} not defined`);
  }
  await applyFamily(family, { dryRun: args.dryRun });
}

main().catch((error: unknown) => {
  process.stderr.write(`Error: ${String(error)}\n`);
  process.exit(1);
});
