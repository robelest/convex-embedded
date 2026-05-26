import { describe, expect, it } from "@tests/testkit";

import { api } from "../../convex/_generated/api";
import * as schemaModule from "../../convex/schema";
import { getEmbeddedClientEntry } from "../../packages/convex-embedded/src/client/entry";
import { createConvexClient } from "../../packages/convex-embedded/src/node/index";
import { createAppModules } from "../helpers/convex";
import { temporaryDatabasePath, uniqueSuffix } from "../helpers/storage";

describe("user table indexes", () => {
  it("builds extracted-column specs with user indexes from the schema module", ({
    track,
  }) => {
    const name = uniqueSuffix("user-index-specs");
    const client = createConvexClient({
      convex: { modules: createAppModules() },
      schema: schemaModule,
      name,
      databasePath: temporaryDatabasePath(name),
    });
    track({ close: () => client.close() });

    const runtime = getEmbeddedClientEntry(client)?.runtime;
    const specs = runtime?.getUserTableSpecs();
    expect(specs).toBeTruthy();

    const issues = specs?.get("issues");
    expect(issues).toBeTruthy();
    expect(Object.keys(issues!.fields)).toEqual(
      expect.arrayContaining(["projectId", "position"]),
    );
    expect(issues!.indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining(["by_projectId_and_position"]),
    );
  });

  it("creates the user index on the physical table and uses it for an indexed query", async ({
    track,
  }) => {
    const name = uniqueSuffix("user-index-explain");
    const client = createConvexClient({
      convex: { modules: createAppModules() },
      schema: schemaModule,
      name,
      databasePath: temporaryDatabasePath(name),
    });
    track({ close: () => client.close() });

    const projectId = await client.mutation(api.projects.create, {
      name: `Index ${name}`,
      identifier: name.slice(-6).toUpperCase(),
      description: `Index ${name}`,
    });
    await client.mutation(api.issues.create, {
      projectId,
      title: `Issue ${name}`,
    });

    const runtime = getEmbeddedClientEntry(client)?.runtime;
    const storage = runtime?.getStorage() as
      | { getDriver?: () => { query: (sql: string) => Promise<unknown[]> } }
      | undefined;
    const driver = storage?.getDriver?.();
    expect(driver).toBeTruthy();

    const indexList = (await driver!.query(
      `PRAGMA index_list("documents__issues")`,
    )) as Array<{ name: string }>;
    expect(indexList.map((row) => row.name)).toEqual(
      expect.arrayContaining(["documents__issues_by_projectId_and_position"]),
    );

    const plan = (await driver!.query(
      `EXPLAIN QUERY PLAN SELECT id FROM "documents__issues" WHERE "projectId" = 'x' ORDER BY "position" ASC, id ASC`,
    )) as Array<{ detail: string }>;
    const planText = plan.map((row) => row.detail).join(" | ");
    expect(planText).toMatch(
      /USING (COVERING )?INDEX documents__issues_by_projectId_and_position/,
    );
    expect(planText).not.toMatch(/\bSCAN documents__issues\b/);
  });
});
