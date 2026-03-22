import {
  prose,
  register,
  counter,
  set,
  omit,
  define,
  isCrdtField,
  getCrdtType,
  initYjsDoc,
  encodeDocumentState,
  computeDiff,
  mergeUpdate,
  isDiffEmpty,
  createConflict,
} from "@resolve/server/schema";
import { CrdtType } from "@resolve/shared/types";
import { v } from "convex/values";
import { describe, it, expect } from "vite-plus/test";
import * as Y from "yjs";

// ---------------------------------------------------------------------------
// Field constructors
// ---------------------------------------------------------------------------

describe("CRDT field constructors", () => {
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
    const resolver = (conflict: any) => conflict.values[0];
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

describe("define()", () => {
  it("creates a Definition with version and shape", () => {
    const def = define({
      version: 1,
      shape: {
        title: register(v.string()),
        body: prose(),
      },
    });

    expect(def.version).toBe(1);
    expect(def.shape).toHaveProperty("title");
    expect(def.shape).toHaveProperty("body");
  });

  it("getShape() returns current shape for current version", () => {
    const def = define({
      version: 2,
      shape: { title: register(v.string()) },
    });

    const shape = def.getShape();
    expect(shape).toHaveProperty("title");
    expect(def.getShape(2)).toBe(shape);
  });

  it("getShape() returns history shape for past version", () => {
    const v1Shape = { title: register(v.string()) };
    const v2Shape = {
      title: register(v.string()),
      priority: register(v.string()),
    };

    const def = define({
      version: 2,
      shape: v2Shape,
      history: { 1: v1Shape },
    });

    expect(def.getShape(1)).toBe(v1Shape);
  });

  it("getShape() throws for unknown version", () => {
    const def = define({
      version: 1,
      shape: { title: register(v.string()) },
    });

    expect(() => def.getShape(99)).toThrow(
      "No schema shape found for version 99",
    );
  });

  it("getCrdtFields() returns only CRDT fields", () => {
    const def = define({
      version: 1,
      shape: {
        title: register(v.string()),
        body: prose(),
        count: counter(),
        plain: "not a crdt field" as any,
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
      version: 1,
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

  it("defaults are stored", () => {
    const def = define({
      version: 2,
      shape: { title: register(v.string()) },
      defaults: { title: "untitled" },
    });

    expect(def.defaults).toEqual({ title: "untitled" });
  });
});

// ---------------------------------------------------------------------------
// Yjs document helpers
// ---------------------------------------------------------------------------

describe("initYjsDoc()", () => {
  it("creates a Y.Doc with a fields map", () => {
    const def = define({
      version: 1,
      shape: {
        title: register(v.string()),
      },
    });

    const doc = initYjsDoc(def, { title: "Hello" });
    const fields = doc.getMap("fields");
    expect(fields).toBeDefined();
  });

  it("initializes a register field as Y.Map with value", () => {
    const def = define({
      version: 1,
      shape: { title: register(v.string()) },
    });

    const doc = initYjsDoc(def, { title: "Test" });
    const fields = doc.getMap("fields");
    const titleMap = fields.get("title") as Y.Map<any>;

    expect(titleMap).toBeInstanceOf(Y.Map);
    const init = titleMap.get("_init");
    expect(init.value).toBe("Test");
  });

  it("initializes a prose field as XmlFragment", () => {
    const def = define({
      version: 1,
      shape: { body: prose() },
    });

    const doc = initYjsDoc(def, { body: "Hello world" });
    const xml = doc.getXmlFragment("body");
    expect(xml.length).toBeGreaterThan(0);
  });

  it("initializes a counter field as Y.Array", () => {
    const def = define({
      version: 1,
      shape: { votes: counter() },
    });

    const doc = initYjsDoc(def, { votes: 5 });
    const fields = doc.getMap("fields");
    const arr = fields.get("votes") as Y.Array<any>;

    expect(arr).toBeInstanceOf(Y.Array);
    expect(arr.length).toBe(1);
    expect(arr.get(0).delta).toBe(5);
  });

  it("initializes a counter with 0 as empty Y.Array", () => {
    const def = define({
      version: 1,
      shape: { votes: counter() },
    });

    const doc = initYjsDoc(def, { votes: 0 });
    const fields = doc.getMap("fields");
    const arr = fields.get("votes") as Y.Array<any>;

    expect(arr.length).toBe(0);
  });

  it("initializes a set field as Y.Map", () => {
    const def = define({
      version: 1,
      shape: { tags: set(v.string()) },
    });

    const doc = initYjsDoc(def, { tags: ["a", "b", "c"] });
    const fields = doc.getMap("fields");
    const setMap = fields.get("tags") as Y.Map<any>;

    expect(setMap).toBeInstanceOf(Y.Map);
    expect(setMap.has("a")).toBe(true);
    expect(setMap.has("b")).toBe(true);
    expect(setMap.has("c")).toBe(true);
  });

  it("skips omitted fields", () => {
    const def = define({
      version: 1,
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
      version: 1,
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

  it("stores plain (non-CRDT) fields as raw values", () => {
    const def = define({
      version: 1,
      shape: { done: "plain_validator" as any },
    });

    const doc = initYjsDoc(def, { done: true });
    const fields = doc.getMap("fields");

    expect(fields.get("done")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Encode / Diff / Merge
// ---------------------------------------------------------------------------

describe("encodeDocumentState()", () => {
  it("encodes a document as a Uint8Array", () => {
    const def = define({
      version: 1,
      shape: { title: register(v.string()) },
    });

    const update = encodeDocumentState(def, { title: "Hello" });
    expect(update).toBeInstanceOf(Uint8Array);
    expect(update.byteLength).toBeGreaterThan(0);
  });
});

describe("computeDiff()", () => {
  it("returns a diff between server and client states", () => {
    const def = define({
      version: 1,
      shape: { title: register(v.string()) },
    });

    // Server has a document
    const serverUpdate = encodeDocumentState(def, { title: "Server value" });

    // Client has an empty state vector
    const clientDoc = new Y.Doc();
    const clientVector = Y.encodeStateVector(clientDoc);

    const diff = computeDiff(serverUpdate, clientVector);
    expect(diff).toBeInstanceOf(Uint8Array);
    expect(diff.byteLength).toBeGreaterThan(2); // Non-empty diff
  });

  it("returns small diff when client is up to date", () => {
    // When the server and client have the SAME Y.Doc (same clientID + clock),
    // the diff is truly empty. But encodeDocumentState creates a fresh doc
    // each time with a different clientID, so a diff between two separate
    // docs with the same logical content will contain the state vector entries.
    // The isDiffEmpty heuristic (<=2 bytes) works for same-origin docs.

    const doc = new Y.Doc();
    const fields = doc.getMap("fields");
    fields.set("title", "value");
    const fullUpdate = Y.encodeStateAsUpdateV2(doc);
    const stateVector = Y.encodeStateVector(doc);

    // Diff same doc against its own state vector → truly empty
    const diff = computeDiff(fullUpdate, stateVector);
    expect(isDiffEmpty(diff)).toBe(true);
  });
});

describe("mergeUpdate()", () => {
  it("merges two updates into a combined state", () => {
    const def = define({
      version: 1,
      shape: { title: register(v.string()) },
    });

    const update1 = encodeDocumentState(def, { title: "First" });
    const update2 = encodeDocumentState(def, { title: "Second" });

    const merged = mergeUpdate(update1, update2);
    expect(merged).toBeInstanceOf(Uint8Array);
    expect(merged.byteLength).toBeGreaterThan(0);
  });
});

describe("isDiffEmpty()", () => {
  it("returns true for 0 bytes", () => {
    expect(isDiffEmpty(new Uint8Array(0))).toBe(true);
  });

  it("returns true for the V2 empty update pattern (13 bytes)", () => {
    const v2Empty = new Uint8Array([0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
    expect(isDiffEmpty(v2Empty)).toBe(true);
  });

  it("returns false for non-empty 13-byte array", () => {
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

describe("createConflict (re-exported)", () => {
  it("is accessible from server/schema", () => {
    const conflict = createConflict([
      { value: "a", clientId: "c1", timestamp: 100 },
    ]);
    expect(conflict.latest()).toBe("a");
  });
});
