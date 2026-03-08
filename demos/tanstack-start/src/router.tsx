import { createRouter } from "@tanstack/react-router";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  const convex = new ConvexReactClient(
    (import.meta as any).env.CONVEX_URL!,
  );

  const router = createRouter({
    routeTree,
    scrollRestoration: true,
    context: { convex },
    Wrap: ({ children }) => (
      <ConvexProvider client={convex}>{children}</ConvexProvider>
    ),
  });

  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
