import {
  prose,
  register,
  counter,
  set,
  omit,
  define,
  isCrdtField,
  getCrdtType,
  createConflict,
  type Conflict,
} from "@resolve/server/schema";
import { CrdtType } from "@resolve/shared/types";
import {
  initYjsDoc,
  encodeDocumentState,
  computeDiff,
  mergeUpdate,
  isDiffEmpty,
} from "@resolve/shared/yjs";
import { describe, it, expect } from "@tests/testkit";
import { v } from "convex/values";
import * as Y from "yjs";

interface RegisterEntry {
  value: unknown;
  timestamp: number;
}

interface CounterEntry {
  client: string;
  delta: number;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Field constructors
// ---------------------------------------------------------------------------

describe.concurrent("CRDT field constructors", () => {
  it("prose() creates a Prose descriptor", () => {
    const field = prose();
    expect(isCrdtField(field)).toBe(true);
    expect(getCrdtType(field)).toBe(CrdtType.Prose);
  });

  it("register() creates a Register descriptor", () => {
    const field = register(v.string());
    expect(isCrdtField(field)).toBe(true);
    expect(getCrdtType(field)).toBe(CrdtType.Register);
  });

  it("register() accepts a custom resolver", () => {
    const resolver = (conflict: Conflict<string>) => conflict.values[0]!;
    const field = register(v.string(), { resolve: resolver });
    expect(field.resolve).toBeDefined();
  });

  it("counter() creates a Counter descriptor", () => {
    const field = counter();
    expect(isCrdtField(field)).toBe(true);
    expect(getCrdtType(field)).toBe(CrdtType.Counter);
  });

  it("set() creates a Set descriptor", () => {
    const field = set(v.string());
    expect(isCrdtField(field)).toBe(true);
    expect(getCrdtType(field)).toBe(CrdtType.Set);
  });

  it("omit() creates an Omitted descriptor", () => {
    const field = omit(v.string());
    expect(isCrdtField(field)).toBe(true);
    expect(getCrdtType(field)).toBe(CrdtType.Omitted);
  });

  it("isCrdtField returns false for plain values", () => {
    expect(isCrdtField("hello")).toBe(false);
    expect(isCrdtField(42)).toBe(false);
    expect(isCrdtField(null)).toBe(false);
    expect(isCrdtField(undefined)).toBe(false);
    expect(isCrdtField({ type: "fake" })).toBe(false);
  });

  it("getCrdtType returns null for non-CRDT values", () => {
    expect(getCrdtType("hello")).toBeNull();
    expect(getCrdtType(42)).toBeNull();
    expect(getCrdtType({})).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// schema.define()
// ---------------------------------------------------------------------------

describe.concurrent("define()", () => {
  it("creates a Definition with version and shape", () => {
    const def = define({
      shape: {
        title: register(v.string()),
        body: prose(),
      },
    });

    expect(def.version).toBe(1);
    expect(def.shape).toHaveProperty("title");
    expect(def.shape).toHaveProperty("body");
  });

  it("getShape() returns a stable shape reference", () => {
    const def = define({
      shape: { title: register(v.string()) },
    });

    const shape = def.getShape();
    expect(shape).toHaveProperty("title");
    expect(def.getShape()).toBe(shape);
  });

  it("stores migration steps and derives version from the max key", () => {
    const migrations = {
      2: async () => undefined,
      3: async () => undefined,
    };

    const def = define({
      shape: { title: register(v.string()) },
      migrations,
    });

    expect(def.migrations).toBe(migrations);
    expect(def.version).toBe(3);
  });

  it("getCrdtFields() returns only CRDT fields", () => {
    const def = define({
      shape: {
        title: register(v.string()),
        body: prose(),
        count: counter(),
        plain: "not a crdt field",
      },
    });

    const fields = def.getCrdtFields();
    expect(fields.size).toBe(3);
    expect(fields.has("title")).toBe(true);
    expect(fields.has("body")).toBe(true);
    expect(fields.has("count")).toBe(true);
    expect(fields.has("plain")).toBe(false);
  });

  it("getOmittedFields() returns omitted field names", () => {
    const def = define({
      shape: {
        title: register(v.string()),
        secret: omit(v.string()),
        hidden: omit(v.number()),
      },
    });

    const omitted = def.getOmittedFields();
    expect(omitted).toContain("secret");
    expect(omitted).toContain("hidden");
    expect(omitted).not.toContain("title");
  });

  it("stores defaults", () => {
    const def = define({
      shape: { title: register(v.string()) },
      defaults: { title: "untitled" },
    });

    expect(def.defaults).toEqual({ title: "untitled" });
  });
});

// ---------------------------------------------------------------------------
// Yjs document helpers
// ---------------------------------------------------------------------------

describe.concurrent("initYjsDoc()", () => {
  it("creates a Y.Doc with a fields map", () => {
    const def = define({
      shape: {
        title: register(v.string()),
      },
    });

    const doc = initYjsDoc(def, { title: "Hello" });
    const fields = doc.getMap("fields");
    expect(fields).toBeDefined();
  });

  it("initializes a register field as a Y.Map with its value", () => {
    const def = define({
      shape: { title: register(v.string()) },
    });

    const doc = initYjsDoc(def, { title: "Test" });
    const fields = doc.getMap("fields");
    const titleMap = fields.get("title");

    expect(titleMap).toBeInstanceOf(Y.Map);
    const init = (titleMap as Y.Map<RegisterEntry>).get("_init");
    expect(init?.value).toBe("Test");
  });

  it("initializes a prose field as an XmlFragment", () => {
    const def = define({
      shape: { body: prose() },
    });

    const doc = initYjsDoc(def, { body: "Hello world" });
    const xml = doc.getXmlFragment("body");
    expect(xml.length).toBeGreaterThan(0);
  });

  it("initializes a counter field as a Y.Array", () => {
    const def = define({
      shape: { votes: counter() },
    });

    const doc = initYjsDoc(def, { votes: 5 });
    const fields = doc.getMap("fields");
    const arr = fields.get("votes") as Y.Array<CounterEntry>;

    expect(arr).toBeInstanceOf(Y.Array);
    expect(arr.length).toBe(1);
    expect(arr.get(0)?.delta).toBe(5);
  });

  it("initializes a counter of 0 as an empty Y.Array", () => {
    const def = define({
      shape: { votes: counter() },
    });

    const doc = initYjsDoc(def, { votes: 0 });
    const fields = doc.getMap("fields");
    const arr = fields.get("votes") as Y.Array<CounterEntry>;

    expect(arr.length).toBe(0);
  });

  it("initializes a set field as a Y.Map keyed by member", () => {
    const def = define({
      shape: { tags: set(v.string()) },
    });

    const doc = initYjsDoc(def, { tags: ["a", "b", "c"] });
    const fields = doc.getMap("fields");
    const setMap = fields.get("tags") as Y.Map<unknown>;

    expect(setMap).toBeInstanceOf(Y.Map);
    expect(setMap.has("a")).toBe(true);
    expect(setMap.has("b")).toBe(true);
    expect(setMap.has("c")).toBe(true);
  });

  it("skips omitted fields", () => {
    const def = define({
      shape: {
        title: register(v.string()),
        secret: omit(v.string()),
      },
    });

    const doc = initYjsDoc(def, { title: "Test", secret: "hidden" });
    const fields = doc.getMap("fields");

    expect(fields.has("title")).toBe(true);
    expect(fields.has("secret")).toBe(false);
  });

  it("skips _id and _creationTime", () => {
    const def = define({
      shape: { title: register(v.string()) },
    });

    const doc = initYjsDoc(def, {
      _id: "abc123",
      _creationTime: 1234567890,
      title: "Test",
    });
    const fields = doc.getMap("fields");

    expect(fields.has("_id")).toBe(false);
    expect(fields.has("_creationTime")).toBe(false);
  });

  it("does not store plain (non-CRDT) fields in the Y.Doc", () => {
    const def = define({
      shape: { done: "plain_validator" },
    });

    const doc = initYjsDoc(def, { done: true });
    const fields = doc.getMap("fields");

    expect(fields.has("done")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Encode / Diff / Merge
// ---------------------------------------------------------------------------

describe.concurrent("encodeDocumentState()", () => {
  it("encodes a document as a Uint8Array", () => {
    const def = define({
      shape: { title: register(v.string()) },
    });

    const update = encodeDocumentState(def, { title: "Hello" });
    expect(update).toBeInstanceOf(Uint8Array);
    expect(update.byteLength).toBeGreaterThan(0);
  });
});

describe.concurrent("computeDiff()", () => {
  it("returns a non-empty diff between server and empty client states", () => {
    const def = define({
      shape: { title: register(v.string()) },
    });

    const serverUpdate = encodeDocumentState(def, { title: "Server value" });
    const clientDoc = new Y.Doc();
    const clientVector = Y.encodeStateVector(clientDoc);

    const diff = computeDiff(serverUpdate, clientVector);
    expect(diff).toBeInstanceOf(Uint8Array);
    expect(diff.byteLength).toBeGreaterThan(2);
  });

  it("returns an empty diff when the client is up to date", () => {
    const doc = new Y.Doc();
    const fields = doc.getMap("fields");
    fields.set("title", "value");
    const fullUpdate = Y.encodeStateAsUpdateV2(doc);
    const stateVector = Y.encodeStateVector(doc);

    const diff = computeDiff(fullUpdate, stateVector);
    expect(isDiffEmpty(diff)).toBe(true);
  });
});

describe.concurrent("mergeUpdate()", () => {
  it("merges two updates into a combined state", () => {
    const def = define({
      shape: { title: register(v.string()) },
    });

    const update1 = encodeDocumentState(def, { title: "First" });
    const update2 = encodeDocumentState(def, { title: "Second" });

    const merged = mergeUpdate(update1, update2);
    expect(merged).toBeInstanceOf(Uint8Array);
    expect(merged.byteLength).toBeGreaterThan(0);
  });
});

describe.concurrent("isDiffEmpty()", () => {
  it("returns true for 0 bytes", () => {
    expect(isDiffEmpty(new Uint8Array(0))).toBe(true);
  });

  it("returns true for the V2 empty update pattern (13 bytes)", () => {
    const v2Empty = new Uint8Array([0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
    expect(isDiffEmpty(v2Empty)).toBe(true);
  });

  it("returns false for a non-empty 13-byte array", () => {
    const notEmpty = new Uint8Array([1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
    expect(isDiffEmpty(notEmpty)).toBe(false);
  });

  it("returns false for small non-V2 arrays", () => {
    expect(isDiffEmpty(new Uint8Array(1))).toBe(false);
    expect(isDiffEmpty(new Uint8Array(2))).toBe(false);
    expect(isDiffEmpty(new Uint8Array(3))).toBe(false);
  });

  it("returns false for larger arrays", () => {
    expect(isDiffEmpty(new Uint8Array(34))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createConflict re-export
// ---------------------------------------------------------------------------

describe.concurrent("createConflict (re-exported)", () => {
  it("is accessible from server/schema", () => {
    const conflict = createConflict([
      { value: "a", clientId: "c1", timestamp: 100 },
    ]);
    expect(conflict.latest()).toBe("a");
  });
});
