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

import { createLogger } from "@/shared/logger";

const log = createLogger("loader");

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
    const childComponentName = parts[2];
    let componentPath = childComponentName ?? "";
    if (currentComponentPath.length > 0) {
      componentPath = `${currentComponentPath}/${componentPath}`;
    }
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

export interface ConvexRemoteTableManifest {
  readonly resolve: string;
  readonly schemaModule?: string;
  readonly schemaExport?: string;
}

export interface ConvexRemoteManifest {
  readonly routeModes?: Record<string, import("@/shared/route").RouteMode>;
  readonly tables: Record<string, ConvexRemoteTableManifest>;
  readonly uploadUrl?: string;
}

export interface ConvexManifest {
  readonly remote?: ConvexRemoteManifest;
}

export interface ConvexInput {
  readonly modules: ConvexModuleRegistry;
  readonly manifest?: ConvexManifest;
}

export function normalizeModuleRegistry<T>(
  modules: Record<string, T>,
): Record<string, T> {
  const normalizedEntries: Array<[string, T]> = [];
  const seen = new Map<string, string>();

  for (const [key, value] of Object.entries(modules)) {
    const normalizedKey = normalizeModuleKey(key);
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
    log.debug(
      "modules:",
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
      return cached;
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

    log.debug("loading:", path);
    const loading = loader().catch((err) => {
      this.loadedModules.delete(path);
      throw err;
    });
    this.loadedModules.set(path, loading);
    return loading;
  }

  /**
   * Eagerly load every user module in the registry. Generated modules
   * (`_generated/*`) are skipped — they're internal routing/codegen
   * scaffolding, not UDF carriers.
   *
   * Intended for warm-start: call once after storage hydration so the first
   * `_resolveFunc` for any user query / mutation / action hits the module
   * cache instead of paying a dynamic-import on the user's critical path.
   *
   * Individual load failures don't reject the whole batch — each module is
   * settled independently and errors are surfaced through `load()` when the
   * function is actually invoked.
   */
  async preloadAll(): Promise<void> {
    const paths = Object.keys(this.modules).filter(
      (key) => !isGeneratedModuleId(key),
    );
    await Promise.allSettled(
      paths.map((path) => this.load(path).catch(() => undefined)),
    );
  }
}

function normalizeModuleKey(key: string): string {
  let normalized = key;

  normalized = normalized.replace(/^\.\//, "");
  normalized = normalized.replace(/^convex\//, "");
  normalized = normalized.replace(/\.[^.]+$/, "");
  return normalized;
}

function isGeneratedModuleId(key: string): boolean {
  return key === "_generated" || key.startsWith("_generated/");
}
