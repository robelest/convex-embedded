import { api } from "$convex/_generated/api.js";
import type { Doc } from "$convex/_generated/dataModel";
import {
  createEmbeddedPrefetch,
  emptyEmbeddedPrefetch,
} from "@robelest/convex-embedded/client";

import type { LayoutServerLoad } from "./$types";

function readConvexUrl(): string | undefined {
  return (
    (import.meta.env.CONVEX_URL as string | undefined) ??
    (process.env.CONVEX_URL as string | undefined) ??
    (process.env.EXPO_PUBLIC_CONVEX_URL as string | undefined) ??
    (process.env.VITE_CONVEX_URL as string | undefined)
  );
}

export const load: LayoutServerLoad = async ({ locals }) => {
  const convexUrl = readConvexUrl();
  const authToken = locals.authToken ?? null;
  const authIdentityKey = locals.authIdentityKey ?? "user_alice";

  let projects: Doc<"projects">[] = [];
  let embedded = emptyEmbeddedPrefetch(authIdentityKey);

  if (convexUrl) {
    try {
      const result = await createEmbeddedPrefetch({
        url: convexUrl,
        token: authToken,
        identityKey: authIdentityKey,
        tables: {
          projects: api.projects.bind,
        },
      });
      embedded = result.embedded;
      projects = (result.snapshots.projects ?? []) as unknown as Doc<"projects">[];
    } catch (error) {
      console.warn("[svelte-demo] failed to prefetch SSR data", error);
    }
  }

  return {
    convexUrl: convexUrl ?? null,
    embedded,
    prefetch: {
      projects,
    },
    auth: {
      token: authToken,
      identityKey: authIdentityKey,
      isAuthenticated: locals.isAuthenticated ?? false,
    },
  };
};
