const path = require("path");
const fs = require("fs");

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
  const shimRoot = path.join(packageRoot, "src/expo/shims");
  const expoAssetShim = path.join(shimRoot, "expo-asset/AssetUris.js");
  const safeAreaShim = path.join(
    shimRoot,
    "react-native-safe-area-context/NativeSafeAreaProvider.js",
  );
  const previousResolveRequest = config.resolver?.resolveRequest;
  const aliases = options.aliases ?? {};

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
