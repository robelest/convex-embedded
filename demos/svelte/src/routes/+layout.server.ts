import { api } from "$convex/_generated/api.js";
import {
  createEmbeddedPrefetch,
  emptyEmbeddedPrefetch,
} from "@robelest/convex-embedded/client";
import type { FunctionReturnType } from "convex/server";

import type { LayoutServerLoad } from "./$types";

type WorkspaceResult = FunctionReturnType<typeof api.workspace.get>;

export const load: LayoutServerLoad = async ({ locals }) => {
  const convexUrl = import.meta.env.CONVEX_URL as string | undefined;
  const authToken = locals.authToken ?? null;
  const authIdentityKey = locals.authIdentityKey ?? null;

  let workspace: WorkspaceResult | null = null;
  let projects: Array<Record<string, unknown>> = [];
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
        queries: {
          workspace: {
            query: api.workspace.get,
            args: {},
          },
        },
      });
      embedded = result.embedded;
      workspace = result.results.workspace;
      projects = result.snapshots.projects ?? [];
    } catch (error) {
      console.warn("[svelte-demo] failed to prefetch SSR data", error);
    }
  }

  return {
    convexUrl: convexUrl ?? null,
    embedded,
    prefetch: {
      workspace,
      projects,
    },
    auth: {
      token: authToken,
      identityKey: authIdentityKey,
      isAuthenticated: locals.isAuthenticated ?? false,
    },
  };
};
