import { convex } from "$convex/_generated/embedded";
import * as schema from "$convex/schema";
import type { UserIdentity } from "@robelest/convex-embedded/auth";
import { createConvexClient } from "@robelest/convex-embedded/expo";
import type { ConvexReactClient } from "convex/react";
import React from "react";

const CONVEX_URL =
  process.env.EXPO_PUBLIC_CONVEX_URL ?? process.env.CONVEX_URL;

const DEMO_IDENTITY: UserIdentity = {
  issuer: "embedded-expo-demo",
  subject: "user_alice",
  tokenIdentifier: "user_alice",
};

type EmbeddedClient = ConvexReactClient;

let clientSingleton: EmbeddedClient | null = null;

const EmbeddedClientContext = React.createContext<EmbeddedClient | null>(null);

export function getClient(): EmbeddedClient {
  clientSingleton ??= createConvexClient({
    convex,
    schema,
    name: "convex-embedded-expo-demo",
    auth: { getUserIdentity: async () => DEMO_IDENTITY },
    ...(CONVEX_URL ? { remote: { url: CONVEX_URL } } : {}),
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
