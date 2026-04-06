const path = require("path");

function withConvexEmbeddedExpoMetro(config, options = {}) {
  const packageRoot = options.packageRoot ?? path.resolve(__dirname, "../..");
  const shimRoot = path.join(packageRoot, "src/expo/shims");
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

    if (previousResolveRequest) {
      return previousResolveRequest(context, moduleName, platform);
    }

    return context.resolveRequest(context, moduleName, platform);
  };

  return config;
}

module.exports = { withConvexEmbeddedExpoMetro };
