const { getDefaultConfig } = require("expo/metro-config");
const {
  withConvexEmbeddedExpoMetro,
} = require("@robelest/convex-embedded/expo/metro");
const path = require("path");

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

// Watch monorepo root so convex/ and packages/ resolve
config.watchFolders = [path.resolve(__dirname, "../..")];
config.resolver = config.resolver ?? {};
config.resolver.nodeModulesPaths = [
  path.resolve(__dirname, "node_modules"),
  path.resolve(__dirname, "../../node_modules"),
];

module.exports = withConvexEmbeddedExpoMetro(config, {
  aliases: {
    "@robelest/convex-embedded/expo": path.resolve(
      __dirname,
      "../../packages/convex-embedded/dist/expo/index.js",
    ),
    "@robelest/convex-embedded/crdt": path.resolve(
      __dirname,
      "../../packages/convex-embedded/dist/crdt/index.js",
    ),
    "$convex/embedded.modules": path.resolve(
      __dirname,
      "../../convex/embedded.modules.ts",
    ),
    "$convex/projects": path.resolve(__dirname, "../../convex/projects.ts"),
    "$convex/issues": path.resolve(__dirname, "../../convex/issues.ts"),
    "$convex/comments": path.resolve(__dirname, "../../convex/comments.ts"),
  },
});
