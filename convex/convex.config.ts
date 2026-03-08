import { defineApp } from "convex/server";
import resolve from "convex-resolve/convex.config";

const app = defineApp();
app.use(resolve);

export default app;
