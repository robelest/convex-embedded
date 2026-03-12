import embedded from "@robelest/convex-embedded/convex.config";
import { defineApp } from "convex/server";

const app = defineApp();
app.use(embedded);

export default app;
