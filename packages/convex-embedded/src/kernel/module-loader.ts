/**
 * Module resolution for Convex functions from `import.meta.glob` records.
 *
 * Resolves UDF paths like `"messages:list"` to their module exports by:
 * 1. Stripping file extensions from the glob keys
 * 2. Finding the modules root via the `_generated` directory
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
 * const loader = new ModuleLoader(import.meta.glob("./convex/** /*.ts"));
 * const mod = await loader.load("messages");
 * const listFn = mod["list"]; // the exported query/mutation/action
 * ```
 */
export class ModuleLoader {
  private readonly prefix: string;
  private readonly modules: Record<string, () => Promise<any>>;

  constructor(modules: Record<string, () => Promise<any>>) {
    // Strip file extensions so callers don't need to specify them.
    this.modules = Object.fromEntries(
      Object.entries(modules).map(([path, loader]) => [
        path.replace(/\.[^.]+$/, ""),
        loader,
      ]),
    );
    this.prefix = findModulesRoot(Object.keys(modules));
  }

  /**
   * Load the module for a given UDF module path (the part before the `:` in a
   * function path, e.g. `"messages"` or `"lib/utils"`).
   */
  async load(path: string): Promise<any> {
    const key = this.prefix + path;
    const loader = this.modules[key];
    if (loader === undefined) {
      const available = Object.keys(this.modules)
        .filter((k) => k.startsWith(this.prefix))
        .map((k) => k.slice(this.prefix.length))
        .join(", ");
      throw new Error(
        `Could not find module for: "${path}". Available modules: ${available}`,
      );
    }
    return await loader();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Determine the common prefix that ends just before the modules root directory
 * by looking for a `_generated` directory in the module paths.
 */
function findModulesRoot(modulesPaths: string[]): string {
  const generatedFilePath = modulesPaths.find((path) =>
    path.includes("_generated"),
  );
  if (generatedFilePath !== undefined) {
    return generatedFilePath.split("_generated", 2)[0];
  }

  throw new Error(
    'Could not find the "_generated" directory in the provided modules. ' +
      "Make sure to run `npx convex dev` or `npx convex codegen`, and that " +
      "your `import.meta.glob` pattern includes the files in the " +
      '"_generated" directory.',
  );
}
