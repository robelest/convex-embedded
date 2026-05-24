import { stripRemoteOnlyExports } from "@embedded/codegen/strip";
import { describe, expect, it } from "@tests/testkit";

function strip(source: string, fileName = "billing.ts") {
  return stripRemoteOnlyExports({ source, fileName });
}

describe.concurrent("stripRemoteOnlyExports", () => {
  it("removes a single remoteOnly export", () => {
    const result = strip(`
import { internalMutation } from "./_generated/server";
import { remoteOnly } from "@robelest/convex-embedded";

export const chargeCard = remoteOnly(internalMutation({}));
`);

    expect(result.removedExports).toEqual(["chargeCard"]);
    expect(result.source).not.toContain("chargeCard");
    expect(result.source).not.toContain("remoteOnly");
  });

  it("leaves an untouched file byte-for-byte identical", () => {
    const source = `
import { query } from "./_generated/server";
export const list = query({});
`;

    const result = strip(source);

    expect(result.removedExports).toEqual([]);
    expect(result.source).toBe(source);
  });

  it("keeps non-remoteOnly exports in a mixed file", () => {
    const result = strip(`
import { internalMutation, query } from "./_generated/server";
import { remoteOnly } from "@robelest/convex-embedded";

export const chargeCard = remoteOnly(internalMutation({}));
export const getReceipt = query({});
`);

    expect(result.removedExports).toEqual(["chargeCard"]);
    expect(result.source).not.toContain("chargeCard");
    expect(result.source).toContain("getReceipt");
    expect(result.source).toContain("query");
  });

  it("detects an aliased remoteOnly import", () => {
    const result = strip(`
import { internalMutation } from "./_generated/server";
import { remoteOnly as ro } from "@robelest/convex-embedded";

export const chargeCard = ro(internalMutation({}));
`);

    expect(result.removedExports).toEqual(["chargeCard"]);
    expect(result.source).not.toContain("chargeCard");
  });

  it("detects namespace import usage", () => {
    const result = strip(`
import { internalMutation } from "./_generated/server";
import * as ce from "@robelest/convex-embedded";

export const chargeCard = ce.remoteOnly(internalMutation({}));
`);

    expect(result.removedExports).toEqual(["chargeCard"]);
    expect(result.source).not.toContain("chargeCard");
  });

  it("ignores type-only remoteOnly imports", () => {
    const result = strip(`
import type { remoteOnly } from "@robelest/convex-embedded";

export const list = "not a function call";
`);

    expect(result.removedExports).toEqual([]);
    expect(result.source).toContain("list");
  });

  it("removes imports used only by the stripped export", () => {
    const result = strip(`
import { internalMutation } from "./_generated/server";
import { remoteOnly } from "@robelest/convex-embedded";
import { secret } from "./secrets";
import { query } from "./_generated/server";

export const chargeCard = remoteOnly(internalMutation({
  handler: async (ctx) => secret(ctx),
}));
export const list = query({});
`);

    expect(result.removedExports).toEqual(["chargeCard"]);
    expect(result.removedImports).toContain("secret");
    expect(result.source).not.toContain("./secrets");
    expect(result.source).toContain("list");
    expect(result.source).toContain("query");
  });

  it("keeps imports shared with non-stripped exports", () => {
    const result = strip(`
import { internalMutation, query } from "./_generated/server";
import { remoteOnly } from "@robelest/convex-embedded";
import { fmt } from "./utils";

export const chargeCard = remoteOnly(internalMutation({
  handler: async () => fmt("hi"),
}));
export const list = query({
  handler: async () => fmt("hi"),
});
`);

    expect(result.removedExports).toEqual(["chargeCard"]);
    expect(result.source).toContain("./utils");
    expect(result.source).toContain("fmt");
    expect(result.source).toContain("list");
  });

  it("preserves type-only imports verbatim", () => {
    const result = strip(`
import type { Doc } from "./_generated/dataModel";
import { internalMutation } from "./_generated/server";
import { remoteOnly } from "@robelest/convex-embedded";

export const chargeCard = remoteOnly(internalMutation({
  handler: async (): Promise<Doc<"charges">> => ({} as never),
}));
`);

    expect(result.removedExports).toEqual(["chargeCard"]);
    expect(result.source).toContain("import type { Doc }");
  });

  it("preserves top-level side-effect statements", () => {
    const result = strip(`
import { internalMutation } from "./_generated/server";
import { remoteOnly } from "@robelest/convex-embedded";

console.log("module loaded");

export const chargeCard = remoteOnly(internalMutation({}));
`);

    expect(result.removedExports).toEqual(["chargeCard"]);
    expect(result.source).toContain('console.log("module loaded")');
  });

  it("preserves unrelated re-exports", () => {
    const result = strip(`
import { internalMutation } from "./_generated/server";
import { remoteOnly } from "@robelest/convex-embedded";

export { something } from "./elsewhere";
export const chargeCard = remoteOnly(internalMutation({}));
`);

    expect(result.removedExports).toEqual(["chargeCard"]);
    expect(result.source).toContain("export { something }");
  });

  it("removes a default export wrapped in remoteOnly", () => {
    const result = strip(`
import { internalMutation } from "./_generated/server";
import { remoteOnly } from "@robelest/convex-embedded";

export default remoteOnly(internalMutation({}));
`);

    expect(result.removedExports).toEqual(["default"]);
    expect(result.source).not.toContain("export default");
  });

  it("reports hasAnyExports false when every registration is remoteOnly", () => {
    const result = strip(`
import { internalMutation } from "./_generated/server";
import { remoteOnly } from "@robelest/convex-embedded";

export const chargeCard = remoteOnly(internalMutation({}));
export const refund     = remoteOnly(internalMutation({}));
`);

    expect(result.removedExports).toEqual(["chargeCard", "refund"]);
    expect(result.hasAnyExports).toBe(false);
  });

  it("reports hasAnyExports true when other exports remain", () => {
    const result = strip(`
import { internalMutation, query } from "./_generated/server";
import { remoteOnly } from "@robelest/convex-embedded";

export const chargeCard = remoteOnly(internalMutation({}));
export const list = query({});
`);

    expect(result.hasAnyExports).toBe(true);
  });

  it("recognizes remoteOnly imported from a package subpath", () => {
    const result = strip(`
import { internalAction } from "./_generated/server";
import { remoteOnly } from "@robelest/convex-embedded/server";

export const charge = remoteOnly(internalAction({}));
`);

    expect(result.removedExports).toEqual(["charge"]);
    expect(result.source).not.toContain("charge");
  });

  it("leaves a file unchanged when remoteOnly is imported but never called", () => {
    const source = `
import { remoteOnly } from "@robelest/convex-embedded";
import { query } from "./_generated/server";
export const list = query({});
`;

    const result = strip(source);

    expect(result.removedExports).toEqual([]);
    expect(result.source).toBe(source);
  });

  it("removes a transitive helper used only by a stripped export", () => {
    const result = strip(`
import { internalMutation } from "./_generated/server";
import { remoteOnly } from "@robelest/convex-embedded";

const formatCharge = (cents: number) => \`$\${cents / 100}\`;

export const chargeCard = remoteOnly(internalMutation({
  handler: async () => formatCharge(100),
}));
`);

    expect(result.removedExports).toEqual(["chargeCard"]);
    expect(result.removedTopLevelBindings).toContain("formatCharge");
    expect(result.source).not.toContain("formatCharge");
  });

  it("keeps a helper shared between stripped and kept exports", () => {
    const result = strip(`
import { internalMutation, query } from "./_generated/server";
import { remoteOnly } from "@robelest/convex-embedded";

const fmt = (n: number) => String(n);

export const chargeCard = remoteOnly(internalMutation({
  handler: async () => fmt(1),
}));
export const list = query({
  handler: async () => fmt(2),
});
`);

    expect(result.removedExports).toEqual(["chargeCard"]);
    expect(result.source).toContain("const fmt");
    expect(result.source).toContain("list");
  });
});
