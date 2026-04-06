const { getDefaultConfig } = require("expo/metro-config");
const {
  withConvexEmbeddedExpoMetro,
} = require("@robelest/convex-embedded/expo/metro");
const path = require("path");

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

// Watch monorepo root so convex/ and packages/ resolve
config.watchFolders = [path.resolve(__dirname, "../..")];

module.exports = withConvexEmbeddedExpoMetro(config, {
  aliases: {
    "$convex/dashboard": path.resolve(__dirname, "../../convex/dashboard.ts"),
    "$convex/projects": path.resolve(__dirname, "../../convex/projects.ts"),
    "$convex/issues": path.resolve(__dirname, "../../convex/issues.ts"),
    "$convex/comments": path.resolve(__dirname, "../../convex/comments.ts"),
  },
});
