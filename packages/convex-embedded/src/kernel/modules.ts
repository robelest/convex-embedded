/**
 * Module resolution for Convex functions from lazy ESM module registries.
 *
 * Resolves UDF paths like `"messages:list"` to their module exports by:
 * 1. Normalizing registry keys to canonical Convex module ids
 * 2. Preserving backward compatibility with legacy glob-style path keys
 * 3. Loading the matching module lazily
 *
 * Also provides function handle creation/resolution for cross-component calls.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FunctionPath = {
  /** Component path (e.g. "" for root, "aggregate" for a child component). */
  componentPath: string;
  /** UDF path in `"module:export"` format (e.g. `"messages:list"`). */
  udfPath: string;
};

type FunctionAddress = {
  name?: string;
  reference?: string;
  functionHandle?: string;
};

// ---------------------------------------------------------------------------
// Global function-handle registry
// ---------------------------------------------------------------------------

const handleToPath = new Map<string, FunctionPath>();

/**
 * Create an opaque function handle string for a given {@link FunctionPath}.
 * The handle can later be resolved back via {@link getFunctionFromHandle}.
 */
export function createFunctionHandle(path: FunctionPath): string {
  const handle = `function://${path.componentPath};${path.udfPath}`;
  handleToPath.set(handle, path);
  return handle;
}

/**
 * Resolve a function handle previously created by {@link createFunctionHandle}.
 */
export function getFunctionFromHandle(handle: string): FunctionPath {
  const cached = handleToPath.get(handle);
  if (cached !== undefined) {
    return cached;
  }
  // Parse the handle even if it wasn't created in this process (e.g. across
  // serialisation boundaries).
  const payload = handle.split("function://")[1];
  if (payload === undefined) {
    throw new Error(`Invalid function handle: "${handle}"`);
  }
  const [componentPath, udfPath] = payload.split(";");
  if (udfPath === undefined) {
    throw new Error(`Malformed function handle: "${handle}"`);
  }
  const path: FunctionPath = { componentPath, udfPath };
  handleToPath.set(handle, path);
  return path;
}

// ---------------------------------------------------------------------------
// resolveFunctionPath
// ---------------------------------------------------------------------------

/**
 * Resolve a function address (as emitted by the Convex runtime) into a
 * canonical {@link FunctionPath}.
 *
 * Addresses come in three flavours:
 * - `{ name: "messages:list" }` — direct UDF path in the current component
 * - `{ reference: "_reference/childComponent/aggregate/path/to/file/fn" }`
 * - `{ functionHandle: "function://..." }` — opaque handle
 */
export function resolveFunctionPath(
  address: FunctionAddress,
  currentComponentPath = "",
): FunctionPath {
  if (address.functionHandle !== undefined) {
    return getFunctionFromHandle(address.functionHandle);
  }

  if (address.name !== undefined) {
    return {
      udfPath: address.name,
      componentPath: currentComponentPath,
    };
  }

  if (address.reference !== undefined) {
    const parts = address.reference.split("/");
    // "_reference/childComponent/<componentName>/path/to/file/functionName"
    const childComponentName = parts[2];
    let componentPath = childComponentName ?? "";
    if (currentComponentPath.length > 0) {
      componentPath = `${currentComponentPath}/${componentPath}`;
    }
    // Remaining segments form "path/to/file/functionName"
    const functionNameWithSlashes = parts.slice(3).join("/");
    const segments = functionNameWithSlashes.split("/");
    const functionName = segments.pop() ?? "default";
    const filepath = segments.join("/");
    return {
      udfPath: `${filepath}:${functionName}`,
      componentPath,
    };
  }

  throw new Error(
    "Function address must have at least one of: name, reference, functionHandle",
  );
}

// ---------------------------------------------------------------------------
// ModuleLoader
// ---------------------------------------------------------------------------

/**
 * Lazy module loader that resolves Convex UDF paths to their ES module exports.
 *
 * @example
 * ```ts
 * const loader = new ModuleLoader({
 *   messages: () => import("./convex/messages"),
 *   "lib/utils": () => import("./convex/lib/utils"),
 * });
 * const mod = await loader.load("messages");
 * const listFn = mod["list"]; // the exported query/mutation/action
 * ```
 */
/** A lazily-loaded ES module — its named exports keyed by export name. */
export type ConvexModule = Record<string, unknown>;
export type ConvexModuleLoader = () => Promise<ConvexModule>;
export type ConvexModuleRegistry = Record<string, ConvexModuleLoader>;

export function normalizeModuleRegistry<T>(
  modules: Record<string, T>,
): Record<string, T> {
  const legacyRoot = inferLegacyModulesRoot(Object.keys(modules));
  const normalizedEntries: Array<[string, T]> = [];
  const seen = new Map<string, string>();

  for (const [key, value] of Object.entries(modules)) {
    const normalizedKey = normalizeModuleKey(key, legacyRoot);
    const existing = seen.get(normalizedKey);
    if (existing !== undefined && existing !== key) {
      throw new Error(
        `Duplicate module id "${normalizedKey}" from registry keys "${existing}" and "${key}". ` +
          "Use unique canonical module ids.",
      );
    }
    seen.set(normalizedKey, key);
    normalizedEntries.push([normalizedKey, value]);
  }

  return Object.fromEntries(normalizedEntries);
}

export class ModuleLoader {
  private readonly modules: ConvexModuleRegistry;
  private readonly loadedModules = new Map<string, Promise<ConvexModule>>();

  constructor(modules: ConvexModuleRegistry) {
    this.modules = normalizeModuleRegistry(modules);
    console.debug(
      "[convex-embedded:loader] modules:",
      Object.keys(this.modules).filter((key) => !isGeneratedModuleId(key)),
    );
  }

  /**
   * Load the module for a given UDF module path (the part before the `:` in a
   * function path, e.g. `"messages"` or `"lib/utils"`).
   */
  async load(path: string): Promise<ConvexModule> {
    const cached = this.loadedModules.get(path);
    if (cached) {
      return await cached;
    }

    const loader = this.modules[path];
    if (loader === undefined) {
      const available = Object.keys(this.modules)
        .filter((key) => !isGeneratedModuleId(key))
        .join(", ");
      throw new Error(
        `Could not find module for: "${path}". Available modules: ${available}`,
      );
    }
    console.debug("[convex-embedded:loader] loading:", path);
    const loading = loader();
    this.loadedModules.set(path, loading);
    return await loading;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Determine the prefix to strip from legacy path-like registry keys.
 */
function inferLegacyModulesRoot(moduleKeys: string[]): string | null {
  const pathLikeKeys = moduleKeys.filter(isPathLikeModuleKey);
  if (pathLikeKeys.length === 0) {
    return null;
  }

  const generatedFilePath = pathLikeKeys.find((path) =>
    path.includes("_generated"),
  );
  if (generatedFilePath !== undefined) {
    return generatedFilePath.split("_generated", 2)[0] ?? null;
  }

  const commonPrefix = longestCommonPrefix(pathLikeKeys);
  const lastSlash = commonPrefix.lastIndexOf("/");
  return lastSlash === -1 ? null : commonPrefix.slice(0, lastSlash + 1);
}

function normalizeModuleKey(key: string, legacyRoot: string | null): string {
  let normalized = key;
  if (legacyRoot && normalized.startsWith(legacyRoot)) {
    normalized = normalized.slice(legacyRoot.length);
  }

  normalized = normalized.replace(/^\.\//, "");
  normalized = normalized.replace(/\.[^.]+$/, "");
  return normalized;
}

function isPathLikeModuleKey(key: string): boolean {
  return key.startsWith(".") || key.startsWith("/") || /\.[^./]+$/.test(key);
}

function isGeneratedModuleId(key: string): boolean {
  return key === "_generated" || key.startsWith("_generated/");
}

function longestCommonPrefix(values: string[]): string {
  if (values.length === 0) {
    return "";
  }

  let prefix = values[0] ?? "";
  for (const value of values.slice(1)) {
    while (!value.startsWith(prefix) && prefix.length > 0) {
      prefix = prefix.slice(0, -1);
    }
    if (prefix.length === 0) {
      break;
    }
  }
  return prefix;
}
