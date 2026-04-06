// Empty shim for `convex/server` on React Native.
// The bundler emits a bare `import "convex/server"` side-effect import
// from type-only imports that aren't fully erased. This shim satisfies
// Metro's resolver without pulling in the real server package.

export {};
