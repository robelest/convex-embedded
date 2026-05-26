import { afterAll, bench, describe } from "@tests/testkit";

import {
  closeTrackedResources,
  buildRow,
  seededSqliteRuntime,
  sizeByLabel,
  type TaskRow,
} from "./helpers";

const medium = sizeByLabel("medium");
const mutationSeeded = await seededSqliteRuntime(medium);
const mutationRuntime = mutationSeeded.runtime;
const querySeeded = await seededSqliteRuntime(medium);
const queryRuntime = querySeeded.runtime;

afterAll(closeTrackedResources);

let insertCounter = medium.docs;

function nextRow(): TaskRow {
  insertCounter += 1;
  return buildRow(insertCounter);
}

describe("local compute (real JS over indexed SQLite)", () => {
  bench("executeLocal mutation insert (write throughput)", async () => {
    await mutationRuntime.executeLocal({
      kind: "mutation",
      path: "tasks:insert",
      args: { row: nextRow() as unknown as Record<string, unknown> },
      applyLocalEffects: false,
    });
  });

  bench("executeLocal mutation insert + applyLocalEffects", async () => {
    await mutationRuntime.executeLocal({
      kind: "mutation",
      path: "tasks:insert",
      args: { row: nextRow() as unknown as Record<string, unknown> },
      applyLocalEffects: true,
    });
  });

  bench("executeLocal query indexed range by_status (instant read)", async () => {
    await queryRuntime.executeLocal({
      kind: "query",
      path: "tasks:byStatus",
      args: { status: "active" },
    });
  });

  bench("executeLocal query indexed range + take 20", async () => {
    await queryRuntime.executeLocal({
      kind: "query",
      path: "tasks:byStatusLimit",
      args: { status: "active", limit: 20 },
    });
  });

  bench("executeLocal query full scan + filter (contrast)", async () => {
    await queryRuntime.executeLocal({
      kind: "query",
      path: "tasks:fullScan",
      args: { status: "active" },
    });
  });
});
