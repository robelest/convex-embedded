import { createReplica, type Replica } from "@robelest/convex-embedded/client";

import { modules } from "../convex-modules";
import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = async () => {
  const convexUrl = import.meta.env.CONVEX_URL as string | undefined;
  let replica: Replica | null = null;

  if (convexUrl) {
    try {
      replica = await createReplica({
        modules,
        url: convexUrl,
      });
    } catch (error) {
      console.warn("[svelte-demo] failed to create SSR replica", error);
      replica = null;
    }
  }

  return {
    convexUrl: convexUrl ?? null,
    replica,
  };
};
