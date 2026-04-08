import schema from "$convex/schema";
import { createEmbeddedRuntime } from "@robelest/convex-embedded";
import type { Replica } from "@robelest/convex-embedded/client";

import { modules } from "../convex-modules";

const DASHBOARD_QUERY = "dashboard:get";

export const load = async ({
  parent,
}: {
  parent: () => Promise<{ replica: Replica | null }>;
}) => {
  const { replica } = await parent();

  if (!replica) {
    return { dashboard: null };
  }

  const runtime = createEmbeddedRuntime({
    modules,
    schema,
    replica,
  });

  try {
    const dashboard = await runtime.executeLocal({
      kind: "query",
      path: DASHBOARD_QUERY,
      args: {},
    });

    return {
      dashboard,
    };
  } catch (error) {
    console.warn("[svelte-demo] failed to load SSR dashboard", error);
    return {
      dashboard: null,
    };
  } finally {
    runtime.shutdown();
  }
};
