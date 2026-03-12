/**
 * Bind the embedded component to all tables declared with
 * `embeddedTable()` in schema.ts. Enables CRDT delta recording
 * and resolve queries.
 *
 * Function registration does not depend on this file — mutations
 * and queries are registered at definition time via
 * `mutationGeneric` / `queryGeneric`.
 */
import { setup } from "@robelest/convex-embedded/server";

import { components } from "./_generated/api";

setup({ component: components.embedded });
