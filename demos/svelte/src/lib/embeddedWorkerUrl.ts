// App-level Vite glue: bundle the dedicated wa-sqlite worker with Vite
// without making the published package depend on Vite-specific imports.
// eslint-disable-next-line import/default
import workerUrl from "../../../../packages/convex-embedded/src/browser/sqlite/worker.ts?worker&url";

export default workerUrl;
