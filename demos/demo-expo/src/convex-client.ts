import { createConvexClient } from "@robelest/convex-embedded/expo";

import { modules } from "./convex-modules";

const CONVEX_URL =
  process.env.EXPO_PUBLIC_CONVEX_URL ??
  "https://academic-pigeon-835.convex.cloud";

export const client = createConvexClient({
  modules,
  name: "convex-embedded-expo-demo",
  remote: { url: CONVEX_URL },
});
