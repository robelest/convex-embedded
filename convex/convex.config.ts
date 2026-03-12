import { defineApp } from "convex/server";

import resolve from "@robelest/convex-embedded/convex.config";

const app = defineApp();
app.use(resolve);

export default app;
