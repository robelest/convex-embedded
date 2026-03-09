import { createRouter } from "@tanstack/react-router";
import { createContext, useContext, useState, useEffect } from "react";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { routeTree } from "./routeTree.gen";

// ---------------------------------------------------------------------------
// Remote URL context — the network toggle creates / destroys a ConvexClient
// for the remote Convex cloud on demand.
// ---------------------------------------------------------------------------
const CONVEX_URL = (import.meta as any).env.CONVEX_URL as string;

export const RemoteUrlContext = createContext<string>(CONVEX_URL);
export function useRemoteUrl() {
  return useContext(RemoteUrlContext);
}

// ---------------------------------------------------------------------------
// Loading shell — shown while the embedded runtime initializes
// ---------------------------------------------------------------------------
function LoadingShell() {
  return (
    <div className="flex items-center justify-center min-h-screen">
      <div className="text-sm text-text-secondary animate-pulse">
        Starting local runtime…
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// App wrapper — initializes the embedded runtime and provides both clients.
// ---------------------------------------------------------------------------
function AppWrapper({ children }: { children: React.ReactNode }) {
  const [localClient, setLocalClient] = useState<ConvexReactClient | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;

    import("./embedded")
      .then(({ getTransport }) => {
        const transport = getTransport();
        if (cancelled) return;
        const client = new ConvexReactClient(transport.url, {
          webSocketConstructor: transport.webSocketConstructor,
        });
        setLocalClient(client);
      })
      .catch((err) => {
        console.error("[convex-embedded] Failed to start local runtime:", err);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (!localClient) {
    return <LoadingShell />;
  }

  return (
    <ConvexProvider client={localClient}>
      <RemoteUrlContext.Provider value={CONVEX_URL}>
        {children}
      </RemoteUrlContext.Provider>
    </ConvexProvider>
  );
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
export function getRouter() {
  const router = createRouter({
    routeTree,
    scrollRestoration: true,
    Wrap: ({ children }) => <AppWrapper>{children}</AppWrapper>,
  });

  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
