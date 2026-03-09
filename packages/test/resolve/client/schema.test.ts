import { describe, it, expect } from "vitest";
import * as Y from "yjs";
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
} from "#resolve/client/schema";

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
