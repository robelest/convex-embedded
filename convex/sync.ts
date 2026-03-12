import { setup } from "@robelest/convex-embedded/server";

import { components } from "./_generated/api";
import { mutation, query } from "./_generated/server";

export const register = setup({
  component: (components as any).resolve,
  mutation,
  query,
});
