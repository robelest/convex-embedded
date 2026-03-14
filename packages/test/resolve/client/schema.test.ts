import {
  extractProseText,
  createEmptyDoc,
  getRegisterConflict,
  resolveRegister,
  getCounterValue,
  getSetMembers,
  encodeStateVector,
  applyUpdate,
  encodeState,
  materializeYjsDoc,
} from "@resolve/client/schema";
import {
  define,
  register,
  counter,
  set,
  omit,
  prose,
  initYjsDoc,
} from "@resolve/server/schema";
import { v } from "convex/values";
import { describe, it, expect } from "vite-plus/test";
import * as Y from "yjs";

// ---------------------------------------------------------------------------
// Prose helpers
// ---------------------------------------------------------------------------

describe("extractProseText()", () => {
  it("extracts text from XmlFragment", () => {
    const doc = new Y.Doc();
    const xml = doc.getXmlFragment("body");
    const text = new Y.XmlText("Hello world");
    xml.insert(0, [text]);

    expect(extractProseText(doc, "body")).toBe("Hello world");
  });

  it("returns empty string for empty fragment", () => {
    const doc = new Y.Doc();
    doc.getXmlFragment("body");

    expect(extractProseText(doc, "body")).toBe("");
  });

  it("concatenates multiple text nodes", () => {
    const doc = new Y.Doc();
    const xml = doc.getXmlFragment("body");
    xml.insert(0, [new Y.XmlText("Hello ")]);
    xml.insert(1, [new Y.XmlText("world")]);

    expect(extractProseText(doc, "body")).toBe("Hello world");
  });
});

describe("createEmptyDoc()", () => {
  it("creates a Y.Doc with a fields map", () => {
    const doc = createEmptyDoc();
    expect(doc).toBeInstanceOf(Y.Doc);
    expect(doc.getMap("fields")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Register conflict helpers
// ---------------------------------------------------------------------------

describe("getRegisterConflict()", () => {
  it("returns null for non-existent field", () => {
    const doc = createEmptyDoc();
    expect(getRegisterConflict(doc, "missing")).toBeNull();
  });

  it("returns null for single-entry register", () => {
    const doc = new Y.Doc();
    const fields = doc.getMap("fields");
    const registerMap = new Y.Map();
    registerMap.set("_init", { value: "only", timestamp: 100 });
    fields.set("title", registerMap);

    expect(getRegisterConflict(doc, "title")).toBeNull();
  });

  it("returns Conflict for multi-entry register", () => {
    const doc = new Y.Doc();
    const fields = doc.getMap("fields");
    const registerMap = new Y.Map();
    registerMap.set("client1", { value: "a", timestamp: 100 });
    registerMap.set("client2", { value: "b", timestamp: 200 });
    fields.set("title", registerMap);

    const conflict = getRegisterConflict<string>(doc, "title");
    expect(conflict).not.toBeNull();
    expect(conflict!.values).toContain("a");
    expect(conflict!.values).toContain("b");
    expect(conflict!.entries).toHaveLength(2);
  });
});

describe("resolveRegister()", () => {
  it("returns undefined for missing field", () => {
    const doc = createEmptyDoc();
    expect(resolveRegister(doc, "missing")).toBeUndefined();
  });

  it("returns value for single entry", () => {
    const doc = new Y.Doc();
    const fields = doc.getMap("fields");
    const registerMap = new Y.Map();
    registerMap.set("_init", { value: "hello", timestamp: 100 });
    fields.set("title", registerMap);

    expect(resolveRegister<string>(doc, "title")).toBe("hello");
  });

  it("uses latest() for multi-entry without custom resolver", () => {
    const doc = new Y.Doc();
    const fields = doc.getMap("fields");
    const registerMap = new Y.Map();
    registerMap.set("c1", { value: "old", timestamp: 100 });
    registerMap.set("c2", { value: "new", timestamp: 200 });
    fields.set("title", registerMap);

    expect(resolveRegister<string>(doc, "title")).toBe("new");
  });

  it("uses custom resolver for multi-entry", () => {
    const doc = new Y.Doc();
    const fields = doc.getMap("fields");
    const registerMap = new Y.Map();
    registerMap.set("c1", { value: "short", timestamp: 200 });
    registerMap.set("c2", { value: "longer text", timestamp: 100 });
    fields.set("title", registerMap);

    // Custom resolver: pick longest string
    const result = resolveRegister<string>(doc, "title", (conflict) => {
      return conflict.values.reduce((a, b) => (a.length >= b.length ? a : b));
    });

    expect(result).toBe("longer text");
  });

  it("returns undefined for empty register", () => {
    const doc = new Y.Doc();
    const fields = doc.getMap("fields");
    const registerMap = new Y.Map();
    fields.set("title", registerMap);

    expect(resolveRegister(doc, "title")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Counter helpers
// ---------------------------------------------------------------------------

describe("getCounterValue()", () => {
  it("returns 0 for missing field", () => {
    const doc = createEmptyDoc();
    expect(getCounterValue(doc, "votes")).toBe(0);
  });

  it("returns 0 for empty counter", () => {
    const doc = new Y.Doc();
    const fields = doc.getMap("fields");
    fields.set("votes", new Y.Array());

    expect(getCounterValue(doc, "votes")).toBe(0);
  });

  it("sums all deltas", () => {
    const doc = new Y.Doc();
    const fields = doc.getMap("fields");
    const arr = new Y.Array();
    arr.push([
      { client: "a", delta: 5, timestamp: 100 },
      { client: "b", delta: 3, timestamp: 200 },
      { client: "a", delta: -2, timestamp: 300 },
    ]);
    fields.set("votes", arr);

    expect(getCounterValue(doc, "votes")).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// Set helpers
// ---------------------------------------------------------------------------

describe("getSetMembers()", () => {
  it("returns empty array for missing field", () => {
    const doc = createEmptyDoc();
    expect(getSetMembers(doc, "tags")).toEqual([]);
  });

  it("returns string members", () => {
    const doc = new Y.Doc();
    const fields = doc.getMap("fields");
    const setMap = new Y.Map();
    setMap.set('"alpha"', { addedBy: "c1", addedAt: 100 });
    setMap.set('"beta"', { addedBy: "c2", addedAt: 200 });
    fields.set("tags", setMap);

    const members = getSetMembers<string>(doc, "tags");
    expect(members).toContain("alpha");
    expect(members).toContain("beta");
  });

  it("returns raw keys when JSON.parse fails", () => {
    const doc = new Y.Doc();
    const fields = doc.getMap("fields");
    const setMap = new Y.Map();
    setMap.set("raw-key", { addedBy: "c1", addedAt: 100 });
    fields.set("tags", setMap);

    const members = getSetMembers(doc, "tags");
    expect(members).toContain("raw-key");
  });
});

// ---------------------------------------------------------------------------
// Yjs encoding helpers
// ---------------------------------------------------------------------------

describe("encodeStateVector()", () => {
  it("returns a Uint8Array", () => {
    const doc = new Y.Doc();
    const sv = encodeStateVector(doc);
    expect(sv).toBeInstanceOf(Uint8Array);
  });
});

describe("applyUpdate()", () => {
  it("applies a V2 update to a doc", () => {
    const doc1 = new Y.Doc();
    const map1 = doc1.getMap("test");
    map1.set("key", "value");
    const update = Y.encodeStateAsUpdateV2(doc1);

    const doc2 = new Y.Doc();
    applyUpdate(doc2, update);
    const map2 = doc2.getMap("test");

    expect(map2.get("key")).toBe("value");
  });
});

describe("encodeState()", () => {
  it("encodes doc as V2 update", () => {
    const doc = new Y.Doc();
    doc.getMap("test").set("key", "value");

    const encoded = encodeState(doc);
    expect(encoded).toBeInstanceOf(Uint8Array);
    expect(encoded.byteLength).toBeGreaterThan(0);

    // Verify round-trip
    const doc2 = new Y.Doc();
    Y.applyUpdateV2(doc2, encoded);
    expect(doc2.getMap("test").get("key")).toBe("value");
  });
});

// ---------------------------------------------------------------------------
// materializeYjsDoc()
// ---------------------------------------------------------------------------

describe("materializeYjsDoc()", () => {
  it("materializes plain fields from a Y.Doc", () => {
    const def = define({
      version: 1,
      shape: { name: v.string(), age: v.number() },
    });

    const doc = initYjsDoc(def, { name: "Alice", age: 30 });
    const result = materializeYjsDoc(def, doc);

    expect(result.name).toBe("Alice");
    expect(result.age).toBe(30);
  });

  it("materializes register fields (single value)", () => {
    const def = define({
      version: 1,
      shape: { title: register(v.string()) },
    });

    const doc = initYjsDoc(def, { title: "Hello" });
    const result = materializeYjsDoc(def, doc);

    expect(result.title).toBe("Hello");
  });

  it("materializes register fields (resolves conflict via latest timestamp)", () => {
    const def = define({
      version: 1,
      shape: { title: register(v.string()) },
    });

    const doc = new Y.Doc();
    const fields = doc.getMap("fields");
    const registerMap = new Y.Map();
    registerMap.set("c1", { value: "old", timestamp: 100 });
    registerMap.set("c2", { value: "new", timestamp: 200 });
    fields.set("title", registerMap);

    const result = materializeYjsDoc(def, doc);

    expect(result.title).toBe("new");
  });

  it("materializes counter fields", () => {
    const def = define({
      version: 1,
      shape: { votes: counter() },
    });

    const doc = new Y.Doc();
    const fields = doc.getMap("fields");
    const arr = new Y.Array();
    arr.push([
      { client: "a", delta: 10, timestamp: 100 },
      { client: "b", delta: 3, timestamp: 200 },
      { client: "a", delta: -1, timestamp: 300 },
    ]);
    fields.set("votes", arr);

    const result = materializeYjsDoc(def, doc);

    expect(result.votes).toBe(12);
  });

  it("materializes set fields", () => {
    const def = define({
      version: 1,
      shape: { tags: set(v.string()) },
    });

    const doc = initYjsDoc(def, { tags: ["alpha", "beta"] });
    const result = materializeYjsDoc(def, doc);

    expect(result.tags).toEqual(expect.arrayContaining(["alpha", "beta"]));
    expect(result.tags).toHaveLength(2);
  });

  it("skips omitted fields", () => {
    const def = define({
      version: 1,
      shape: {
        name: v.string(),
        secret: omit(v.string()),
      },
    });

    const doc = initYjsDoc(def, { name: "Alice", secret: "hidden" });
    const result = materializeYjsDoc(def, doc);

    expect(result.name).toBe("Alice");
    expect(result).not.toHaveProperty("secret");
  });

  it("does not include _id or _creationTime", () => {
    const def = define({
      version: 1,
      shape: { name: v.string() },
    });

    // initYjsDoc already skips _id/_creationTime, but even if the Y.Doc
    // somehow has them in the fields map, materializeYjsDoc iterates only
    // over schemaDef.shape — so they never appear.
    const doc = initYjsDoc(def, {
      _id: "abc123",
      _creationTime: 1234567890,
      name: "Alice",
    });
    const result = materializeYjsDoc(def, doc);

    expect(result).not.toHaveProperty("_id");
    expect(result).not.toHaveProperty("_creationTime");
    expect(result.name).toBe("Alice");
  });

  it("round-trips initYjsDoc -> materializeYjsDoc", () => {
    const def = define({
      version: 1,
      shape: {
        title: register(v.string()),
        body: prose(),
        votes: counter(),
        tags: set(v.string()),
        plain: v.number(),
      },
    });

    const original = {
      title: "My Post",
      body: "Hello world",
      votes: 7,
      tags: ["a", "b"],
      plain: 42,
    };

    const doc = initYjsDoc(def, original);
    const result = materializeYjsDoc(def, doc);

    expect(result.title).toBe("My Post");
    expect(result.body).toBe("Hello world");
    expect(result.votes).toBe(7);
    expect(result.tags).toEqual(expect.arrayContaining(["a", "b"]));
    expect((result.tags as string[]).length).toBe(2);
    expect(result.plain).toBe(42);
  });

  it("handles empty Y.Doc (all fields return defaults/empty)", () => {
    const def = define({
      version: 1,
      shape: {
        title: register(v.string()),
        body: prose(),
        votes: counter(),
        tags: set(v.string()),
      },
    });

    const doc = createEmptyDoc();
    const result = materializeYjsDoc(def, doc);

    expect(result.title).toBeUndefined();
    expect(result.body).toBe("");
    expect(result.votes).toBe(0);
    expect(result.tags).toEqual([]);
  });
});
