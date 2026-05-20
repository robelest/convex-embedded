const path = require("path");
const fs = require("fs");
const { spawnSync } = require("child_process");
const { pathToFileURL } = require("url");

const DEFAULT_IMPORT_ID = "$convex/_generated/embedded";

function codegenInput(options) {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  return {
    projectRoot,
    convexDir: options.convexDir ?? "./convex",
    outFile: options.out ?? "./convex/_generated/embedded.ts",
  };
}

function runCodegenSync(options, packageRoot) {
  if (options.codegen === false) {
    return;
  }
  const codegenPath = path.join(packageRoot, "dist/codegen.js");
  if (!fs.existsSync(codegenPath)) {
    throw new Error(
      `[convex-embedded] Expo Metro codegen requires ${codegenPath}. ` +
        "Build @robelest/convex-embedded before starting Expo.",
    );
  }

  const { projectRoot, convexDir, outFile } = codegenInput(options);
  const script = `
    const mod = await import(${JSON.stringify(pathToFileURL(codegenPath).href)});
    if (typeof mod.generateEmbeddedRegistry !== "function") {
      throw new Error("generateEmbeddedRegistry export not found");
    }
    await mod.generateEmbeddedRegistry(${JSON.stringify({
      convexDir,
      outFile,
      cwd: projectRoot,
    })});
  `;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: "pipe",
    },
  );

  if (result.status !== 0) {
    const detail = result.stderr || result.stdout || "unknown failure";
    throw new Error(`[convex-embedded] Expo Metro codegen failed:\n${detail}`);
  }
}

function startCodegenWatcher(options, packageRoot) {
  if (options.codegen === false || options.watch === false) {
    return null;
  }
  const { projectRoot, convexDir, outFile } = codegenInput(options);
  const convexRoot = path.resolve(projectRoot, convexDir);
  const generatedRoot = path.resolve(convexRoot, "_generated");
  const generatedFile = path.resolve(projectRoot, outFile);
  if (!fs.existsSync(convexRoot)) {
    return null;
  }

  let pending = null;
  const run = () => {
    try {
      runCodegenSync(options, packageRoot);
    } catch (error) {
      console.warn("[convex-embedded] Expo Metro codegen watch failed:", error);
    }
  };

  const watcher = fs.watch(
    convexRoot,
    { recursive: true },
    (_event, filename) => {
      if (!filename) return;
      const absolute = path.resolve(convexRoot, filename.toString());
      if (
        absolute === generatedFile ||
        absolute === generatedRoot ||
        absolute.startsWith(generatedRoot + path.sep)
      ) {
        return;
      }
      if (!/\.(ts|tsx|mts|cts)$/.test(absolute)) return;
      if (pending !== null) clearTimeout(pending);
      pending = setTimeout(() => {
        pending = null;
        run();
      }, options.debounceMs ?? 50);
    },
  );

  return {
    close() {
      if (pending !== null) clearTimeout(pending);
      watcher.close();
    },
  };
}

function resolveSourceFile(basePath) {
  const candidates = [
    basePath,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    `${basePath}.js`,
    `${basePath}.jsx`,
    path.join(basePath, "index.ts"),
    path.join(basePath, "index.tsx"),
    path.join(basePath, "index.js"),
    path.join(basePath, "index.jsx"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return basePath;
}

function withConvexEmbeddedExpoMetro(config, options = {}) {
  const packageRoot = options.packageRoot ?? path.resolve(__dirname, "../..");
  runCodegenSync(options, packageRoot);
  const codegenWatcher = startCodegenWatcher(options, packageRoot);
  if (codegenWatcher) {
    Object.defineProperty(config, "__convexEmbeddedCodegenWatcher", {
      value: codegenWatcher,
      configurable: true,
    });
  }
  const shimRoot = path.join(packageRoot, "src/expo/shims");
  const expoAssetShim = path.join(shimRoot, "expo-asset/AssetUris.js");
  const safeAreaShim = path.join(
    shimRoot,
    "react-native-safe-area-context/NativeSafeAreaProvider.js",
  );
  const previousResolveRequest = config.resolver?.resolveRequest;
  const aliases = options.aliases ?? {};
  const importIds = new Set(
    Array.isArray(options.importId)
      ? options.importId
      : [options.importId ?? DEFAULT_IMPORT_ID],
  );

  config.resolver = config.resolver ?? {};
  config.resolver.extraNodeModules = {
    ...config.resolver.extraNodeModules,
    "isomorphic-webcrypto": path.join(shimRoot, "isomorphic-webcrypto"),
    "convex/server": path.join(shimRoot, "convex-server"),
  };

  config.resolver.resolveRequest = (context, moduleName, platform) => {
    if (
      typeof moduleName === "string" &&
      moduleName.includes("setUpFuseboxReactDevToolsDispatcher")
    ) {
      return {
        filePath: path.join(
          shimRoot,
          "react-native/setUpFuseboxReactDevToolsDispatcher.js",
        ),
        type: "sourceFile",
      };
    }

    if (moduleName in aliases) {
      if (importIds.has(moduleName)) {
        runCodegenSync(options, packageRoot);
      }
      return {
        filePath: aliases[moduleName],
        type: "sourceFile",
      };
    }

    for (const [alias, target] of Object.entries(aliases)) {
      if (
        typeof moduleName === "string" &&
        moduleName.startsWith(`${alias}/`)
      ) {
        return {
          filePath: resolveSourceFile(
            path.join(target, moduleName.slice(alias.length + 1)),
          ),
          type: "sourceFile",
        };
      }
    }

    if (
      moduleName === "./AssetUris" &&
      typeof context.originModulePath === "string" &&
      context.originModulePath.includes("expo-asset")
    ) {
      return {
        filePath: expoAssetShim,
        type: "sourceFile",
      };
    }

    if (
      moduleName === "./NativeSafeAreaProvider" &&
      typeof context.originModulePath === "string" &&
      context.originModulePath.includes("react-native-safe-area-context")
    ) {
      return {
        filePath: safeAreaShim,
        type: "sourceFile",
      };
    }

    if (previousResolveRequest) {
      return previousResolveRequest(context, moduleName, platform);
    }

    return context.resolveRequest(context, moduleName, platform);
  };

  return config;
}

module.exports = { withConvexEmbeddedExpoMetro };
