import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRouteWithContext,
} from "@tanstack/react-router";
import type { ConvexReactClient } from "convex/react";

export const Route = createRootRouteWithContext<{
  convex: ConvexReactClient;
}>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
    ],
  }),
  component: RootComponent,
});

function RootComponent() {
  return (
    <html>
      <head>
        <HeadContent />
      </head>
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0 }}>
        <Outlet />
        <Scripts />
      </body>
    </html>
  );
}
