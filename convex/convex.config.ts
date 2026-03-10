import { defineApp } from "convex/server";

import resolve from "@robelest/convex-resolve/convex.config";

const app = defineApp();
app.use(resolve);

export default app;
