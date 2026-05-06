import { convex } from "$convex/_generated/embedded";
import schema, { comments, issues, projects } from "$convex/schema";
import { createConvexClient } from "@robelest/convex-embedded/expo";
import type { ConvexReactClient } from "convex/react";
import React from "react";

const CONVEX_URL =
  process.env.EXPO_PUBLIC_CONVEX_URL ??
  "https://academic-pigeon-835.convex.cloud";

type EmbeddedClient = ConvexReactClient;

let clientSingleton: EmbeddedClient | null = null;

const EmbeddedClientContext = React.createContext<EmbeddedClient | null>(null);

export function getClient(): EmbeddedClient {
  clientSingleton ??= createConvexClient({
    convex,
    schema,
    name: "convex-embedded-expo-demo",
    remote: { url: CONVEX_URL },
  });
  return clientSingleton;
}

export function EmbeddedClientProvider({
  client,
  children,
}: {
  client: EmbeddedClient;
  children: React.ReactNode;
}) {
  return (
    <EmbeddedClientContext.Provider value={client}>
      {children}
    </EmbeddedClientContext.Provider>
  );
}

export function useEmbeddedClient(): EmbeddedClient {
  const client = React.useContext(EmbeddedClientContext);
  if (!client) {
    throw new Error(
      "useEmbeddedClient must be used within EmbeddedClientProvider",
    );
  }
  return client;
}
