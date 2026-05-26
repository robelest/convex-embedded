import { api } from "$convex/_generated/api.js";
import { emptyPreloaded, preloadQuery } from "@robelest/convex-embedded/client";

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

  let preloadedProjects = emptyPreloaded(api.projects.list, {});

  if (convexUrl) {
    try {
      preloadedProjects = await preloadQuery(
        api.projects.list,
        {},
        { url: convexUrl, token: authToken },
      );
    } catch (error) {
      console.warn("[svelte-demo] failed to preload SSR data", error);
    }
  }

  return {
    convexUrl: convexUrl ?? null,
    preloadedProjects,
    auth: {
      token: authToken,
      identityKey: authIdentityKey,
      isAuthenticated: locals.isAuthenticated ?? false,
    },
  };
};
