import {
  getStoredVersion,
  listStoredVersions,
  setStoredVersion,
} from "@embedded/runtime/migrations/versions";
import { describe, expect, it } from "@tests/testkit";

describe("runtime migration versions", () => {
  it("returns the max version for the matching store scope and identity", async ({
    db,
  }) => {
    await setStoredVersion(db, {
      store: "pending",
      scope: "identity",
      identityKey: "user:a",
      version: 1,
    });
    db.startTransaction();
    db.insert("_resolve_store_versions", {
      store: "pending",
      scope: "identity",
      identityKey: "user:a",
      version: 3,
    });
    db.insert("_resolve_store_versions", {
      store: "pending",
      scope: "identity",
      identityKey: "user:b",
      version: 9,
    });
    db.commit();

    await expect(
      getStoredVersion(db, {
        store: "pending",
        scope: "identity",
        identityKey: "user:a",
      }),
    ).resolves.toBe(3);
  });

  describe("setStoredVersion deduplication", () => {
    it("collapses matching rows into a single updated row", async ({ db }) => {
      db.startTransaction();
      db.insert("_resolve_store_versions", {
        store: "pending",
        scope: "identity",
        identityKey: "user:a",
        version: 1,
      });
      db.insert("_resolve_store_versions", {
        store: "pending",
        scope: "identity",
        identityKey: "user:a",
        version: 2,
      });
      db.commit();

      await setStoredVersion(db, {
        store: "pending",
        scope: "identity",
        identityKey: "user:a",
        version: 4,
      });

      const matching = (await listStoredVersions(db)).filter(
        (row) =>
          row.store === "pending" &&
          row.scope === "identity" &&
          row.identityKey === "user:a",
      );
      expect(matching).toHaveLength(1);
      expect(matching[0]?.version).toBe(4);
    });

    it("leaves other identities and scopes untouched", async ({ db }) => {
      db.startTransaction();
      db.insert("_resolve_store_versions", {
        store: "pending",
        scope: "identity",
        identityKey: "user:a",
        version: 1,
      });
      db.insert("_resolve_store_versions", {
        store: "pending",
        scope: "identity",
        identityKey: "user:b",
        version: 7,
      });
      db.insert("_resolve_store_versions", {
        store: "pending",
        scope: "global",
        identityKey: null,
        version: 5,
      });
      db.commit();

      await setStoredVersion(db, {
        store: "pending",
        scope: "identity",
        identityKey: "user:a",
        version: 4,
      });

      const rows = await listStoredVersions(db);
      expect(
        rows.find(
          (row) =>
            row.store === "pending" &&
            row.scope === "identity" &&
            row.identityKey === "user:b",
        )?.version,
      ).toBe(7);
      expect(
        rows.find((row) => row.store === "pending" && row.scope === "global")
          ?.version,
      ).toBe(5);
    });
  });
});
