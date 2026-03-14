import { Database } from "@embedded/core/database";
import type { ParsedSchema } from "@embedded/core/schema";
import { describe, it, expect } from "vite-plus/test";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a schema-less database. */
function createDb(): Database {
  return new Database(null);
}

/** Create a database with a "messages" table schema. */
function createSchemaDb(): Database {
  const schema: ParsedSchema = {
    schemaValidation: true,
    tables: new Map([
      [
        "messages",
        {
          indexes: [],
          vectorIndexes: [],
          documentType: {
            type: "object",
            value: {
              body: { fieldType: { type: "string" }, optional: false },
              author: { fieldType: { type: "string" }, optional: false },
            },
          },
        },
      ],
    ]),
  };
  return new Database(schema);
}

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

describe("Database — ID generation", () => {
  it("insert creates UUID-format IDs", () => {
    const db = createDb();
    db.startTransaction();
    const id = db.insert("tasks", { title: "test" });
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    db.commit();
  });

  it("IDs are unique across inserts", () => {
    const db = createDb();
    db.startTransaction();
    const id1 = db.insert("tasks", { title: "a" });
    const id2 = db.insert("tasks", { title: "b" });
    const id3 = db.insert("other", { x: 1 });
    expect(id1).not.toBe(id2);
    expect(id1).not.toBe(id3);
    expect(id2).not.toBe(id3);
    db.commit();
  });
});

// ---------------------------------------------------------------------------
// CRUD operations
// ---------------------------------------------------------------------------

describe("Database — CRUD", () => {
  it("insert + get: returns document with _id and _creationTime", () => {
    const db = createDb();
    db.startTransaction();
    const id = db.insert("tasks", { title: "hello" });
    const doc = db.get("tasks", id);
    expect(doc).not.toBeNull();
    expect(doc!._id).toBe(id);
    expect(doc!._creationTime).toBeTypeOf("number");
    expect(doc!.title).toBe("hello");
    db.commit();
  });

  it("patch: modifies specified fields, preserves unpatched fields", () => {
    const db = createDb();
    db.startTransaction();
    const id = db.insert("tasks", { title: "original", priority: 1 });
    db.patch("tasks", id, { title: "updated" });
    const doc = db.get("tasks", id)!;
    expect(doc.title).toBe("updated");
    expect(doc.priority).toBe(1);
    db.commit();
  });

  it("replace: replaces all user fields", () => {
    const db = createDb();
    db.startTransaction();
    const id = db.insert("tasks", { title: "old", priority: 1 });
    db.replace("tasks", id, { title: "new" });
    const doc = db.get("tasks", id)!;
    expect(doc.title).toBe("new");
    expect(doc.priority).toBeUndefined();
    expect(doc._id).toBe(id);
    expect(doc._creationTime).toBeTypeOf("number");
    db.commit();
  });

  it("delete: document returns null after deletion", () => {
    const db = createDb();
    db.startTransaction();
    const id = db.insert("tasks", { title: "bye" });
    expect(db.get("tasks", id)).not.toBeNull();
    db.delete("tasks", id);
    expect(db.get("tasks", id)).toBeNull();
    db.commit();
  });

  it("get on non-existent ID returns null", () => {
    const db = createDb();
    db.startTransaction();
    const result = db.get(
      undefined,
      "00000000-0000-4000-8000-000000000000" as any,
    );
    expect(result).toBeNull();
    db.commit();
  });
});

// ---------------------------------------------------------------------------
// Transaction semantics
// ---------------------------------------------------------------------------

describe("Database — transactions", () => {
  it("writes are visible within the transaction", () => {
    const db = createDb();
    db.startTransaction();
    const id = db.insert("tasks", { title: "visible" });
    expect(db.get("tasks", id)!.title).toBe("visible");
    db.commit();
  });

  it("commit() applies writes — visible after commit", () => {
    const db = createDb();
    db.startTransaction();
    const id = db.insert("tasks", { title: "persisted" });
    db.commit();

    // Start a new transaction and read the committed document.
    db.startTransaction();
    const doc = db.get("tasks", id);
    expect(doc).not.toBeNull();
    expect(doc!.title).toBe("persisted");
    db.commit();
  });

  it("rollbackWrites() discards writes", () => {
    const db = createDb();
    db.startTransaction();
    const id = db.insert("tasks", { title: "rolled-back" });
    db.rollbackWrites();

    db.startTransaction();
    const doc = db.get("tasks", id);
    expect(doc).toBeNull();
    db.commit();
  });

  it("nested transactions: child commit merges into parent", () => {
    const db = createDb();
    db.startTransaction(); // parent
    const id1 = db.insert("tasks", { title: "parent-write" });

    db.startTransaction(); // child
    const id2 = db.insert("tasks", { title: "child-write" });
    db.commit(); // child commit — merges into parent

    // Both should be visible in the parent transaction.
    expect(db.get("tasks", id1)).not.toBeNull();
    expect(db.get("tasks", id2)).not.toBeNull();
    db.commit(); // parent commit

    // Both persisted.
    db.startTransaction();
    expect(db.get("tasks", id1)).not.toBeNull();
    expect(db.get("tasks", id2)).not.toBeNull();
    db.commit();
  });

  it("nested transactions: child rollback discards only child writes", () => {
    const db = createDb();
    db.startTransaction(); // parent
    const id1 = db.insert("tasks", { title: "parent-write" });

    db.startTransaction(); // child
    const id2 = db.insert("tasks", { title: "child-write" });
    db.rollbackWrites(); // child rollback

    // Parent write should still be visible.
    expect(db.get("tasks", id1)).not.toBeNull();
    // Child write should be gone.
    expect(db.get("tasks", id2)).toBeNull();
    db.commit();
  });
});

// ---------------------------------------------------------------------------
// MVCC timestamps
// ---------------------------------------------------------------------------

describe("Database — MVCC timestamps", () => {
  it("initial timestamp is 0", () => {
    const db = createDb();
    expect(db.timestamp).toBe(0);
  });

  it("timestamp increments on commit with writes", () => {
    const db = createDb();
    db.startTransaction();
    db.insert("tasks", { title: "a" });
    db.commit();
    expect(db.timestamp).toBe(1);
  });

  it("timestamp does NOT increment on commit without writes", () => {
    const db = createDb();
    db.startTransaction();
    // No writes.
    db.commit();
    expect(db.timestamp).toBe(0);
  });

  it("timestamp does NOT increment on rollback", () => {
    const db = createDb();
    db.startTransaction();
    db.insert("tasks", { title: "a" });
    db.rollbackWrites();
    expect(db.timestamp).toBe(0);
  });

  it("timestamp increments correctly across multiple commits", () => {
    const db = createDb();

    db.startTransaction();
    db.insert("tasks", { title: "a" });
    db.commit();
    expect(db.timestamp).toBe(1);

    db.startTransaction();
    db.insert("tasks", { title: "b" });
    db.commit();
    expect(db.timestamp).toBe(2);

    // Read-only transaction — no bump.
    db.startTransaction();
    db.commit();
    expect(db.timestamp).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// tablesWritten tracking
// ---------------------------------------------------------------------------

describe("Database — tablesWritten", () => {
  it("commit() returns the set of written tables", () => {
    const db = createDb();
    db.startTransaction();
    db.insert("tasks", { title: "a" });
    const { tablesWritten } = db.commit();
    expect(tablesWritten).toBeInstanceOf(Set);
    expect(tablesWritten.has("tasks")).toBe(true);
  });

  it("tracks multiple tables when writing to multiple tables", () => {
    const db = createDb();
    db.startTransaction();
    db.insert("tasks", { title: "a" });
    db.insert("users", { name: "alice" });
    const { tablesWritten } = db.commit();
    expect(tablesWritten.has("tasks")).toBe(true);
    expect(tablesWritten.has("users")).toBe(true);
    expect(tablesWritten.size).toBe(2);
  });

  it("returns empty set for read-only transaction", () => {
    const db = createDb();
    db.startTransaction();
    const { tablesWritten } = db.commit();
    expect(tablesWritten.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

describe("Database — schema validation", () => {
  it("inserting a valid document succeeds", () => {
    const db = createSchemaDb();
    db.startTransaction();
    expect(() =>
      db.insert("messages", { body: "hello", author: "alice" }),
    ).not.toThrow();
    db.commit();
  });

  it("inserting an invalid document throws (missing required field)", () => {
    const db = createSchemaDb();
    db.startTransaction();
    expect(() => db.insert("messages", { body: "hello" })).toThrow(
      /Missing required field/,
    );
  });

  it("inserting an invalid document throws (extra field)", () => {
    const db = createSchemaDb();
    db.startTransaction();
    expect(() =>
      db.insert("messages", { body: "hello", author: "alice", extra: true }),
    ).toThrow(/Unexpected field/);
  });

  it("inserting an invalid document throws (wrong type)", () => {
    const db = createSchemaDb();
    db.startTransaction();
    expect(() => db.insert("messages", { body: 123, author: "alice" })).toThrow(
      /Validator error/,
    );
  });

  it("inserting into an unschema'd table (not in schema) succeeds", () => {
    const db = createSchemaDb();
    db.startTransaction();
    // "other" is not defined in the schema, so no validation occurs.
    expect(() => db.insert("other", { anything: true })).not.toThrow();
    db.commit();
  });
});

// ---------------------------------------------------------------------------
// normalizeId
// ---------------------------------------------------------------------------

describe("Database — normalizeId", () => {
  it("valid ID for the correct table returns itself", () => {
    const db = createDb();
    db.startTransaction();
    const id = db.insert("tasks", { title: "a" });
    expect(db.normalizeId("tasks", id)).toBe(id);
    db.commit();
  });

  it("ID for a different table returns null", () => {
    const db = createDb();
    db.startTransaction();
    const id = db.insert("tasks", { title: "a" });
    expect(db.normalizeId("users", id)).toBeNull();
    db.commit();
  });

  it("non-ID string returns null", () => {
    const db = createDb();
    expect(db.normalizeId("tasks", "random-string")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------------------

describe("Database — error cases", () => {
  it("patch on non-existent document throws", () => {
    const db = createDb();
    db.startTransaction();
    expect(() =>
      db.patch("tasks", "00000000-0000-4000-8000-000000000000" as any, {
        x: 1,
      }),
    ).toThrow(/non-existent/);
    db.commit();
  });

  it("delete on non-existent document throws", () => {
    const db = createDb();
    db.startTransaction();
    expect(() =>
      db.delete("tasks", "00000000-0000-4000-8000-000000000000" as any),
    ).toThrow(/non-existent/);
    db.commit();
  });

  it("replace on non-existent document throws", () => {
    const db = createDb();
    db.startTransaction();
    expect(() =>
      db.replace("tasks", "00000000-0000-4000-8000-000000000000" as any, {
        title: "new",
      }),
    ).toThrow(/non-existent/);
    db.commit();
  });

  it("write outside transaction throws", () => {
    const db = createDb();
    expect(() => db.insert("tasks", { title: "fail" })).toThrow(
      /outside of transaction/,
    );
  });
});
