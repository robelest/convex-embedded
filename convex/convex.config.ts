import agent from "@convex-dev/agent/convex.config";
import embedded from "@robelest/convex-embedded/convex.config";
import { defineApp } from "convex/server";

const app = defineApp();
app.use(agent);
app.use(embedded);

export default app;
