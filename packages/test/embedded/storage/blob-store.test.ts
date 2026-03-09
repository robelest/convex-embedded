import { describe, it, expect } from "vitest";
import { BlobStore } from "#embedded/storage/blob-store.js";

describe("BlobStore", () => {
  it("store: stores a blob and returns a unique storage ID", async () => {
    const store = new BlobStore();
    const blob = new Blob(["hello world"], { type: "text/plain" });

    const id = await store.store(blob);

    expect(id).toBe("storage:1");
  });

  it("store multiple: each blob gets a unique ID", async () => {
    const store = new BlobStore();
    const a = await store.store(new Blob(["a"]));
    const b = await store.store(new Blob(["b"]));
    const c = await store.store(new Blob(["c"]));

    expect(a).toBe("storage:1");
    expect(b).toBe("storage:2");
    expect(c).toBe("storage:3");
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("get: retrieves a previously stored blob", async () => {
    const store = new BlobStore();
    const blob = new Blob(["hello world"], { type: "text/plain" });
    const id = await store.store(blob);

    const retrieved = store.get(id);

    expect(retrieved).toBe(blob);
  });

  it("get non-existent: returns null", () => {
    const store = new BlobStore();

    expect(store.get("storage:999")).toBeNull();
  });

  it("delete: removes the blob and returns true", async () => {
    const store = new BlobStore();
    const blob = new Blob(["to delete"]);
    const id = await store.store(blob);

    const result = store.delete(id);

    expect(result).toBe(true);
  });

  it("delete non-existent: returns false", () => {
    const store = new BlobStore();

    expect(store.delete("storage:999")).toBe(false);
  });

  it("get after delete: returns null", async () => {
    const store = new BlobStore();
    const id = await store.store(new Blob(["ephemeral"]));
    store.delete(id);

    expect(store.get(id)).toBeNull();
  });

  it("getUrl: returns a synthetic URL for an existing blob", async () => {
    const store = new BlobStore();
    const id = await store.store(new Blob(["content"]));

    const url = store.getUrl(id);

    expect(url).toBe(`blob://embedded.local/${id}`);
  });

  it("getUrl non-existent: returns null", () => {
    const store = new BlobStore();

    expect(store.getUrl("storage:999")).toBeNull();
  });

  it("generateUploadUrl: returns a unique URL each time", () => {
    const store = new BlobStore();

    const url1 = store.generateUploadUrl();
    const url2 = store.generateUploadUrl();

    expect(url1).toMatch(/^blob:\/\/embedded\.local\/upload\/\d+$/);
    expect(url2).toMatch(/^blob:\/\/embedded\.local\/upload\/\d+$/);
    expect(url1).not.toBe(url2);
  });
});
