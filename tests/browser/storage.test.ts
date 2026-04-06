import { EmbeddedRuntime } from "@embedded/runtime/embedded";
import { createBrowserStorageSurface } from "@resolve/browser/storage";
import { afterEach, describe, expect, it } from "vite-plus/test";

const runtimes: EmbeddedRuntime[] = [];
const surfaces: Array<{ close(): void }> = [];

afterEach(() => {
  for (const surface of surfaces.splice(0)) {
    surface.close();
  }
  for (const runtime of runtimes.splice(0)) {
    runtime.shutdown();
  }
});

describe("browser storage surface", () => {
  it("supports local upload URLs and blob-backed getUrl", async () => {
    const runtime = new EmbeddedRuntime({ modules: {} });
    runtimes.push(runtime);

    const surface = createBrowserStorageSurface(runtime);
    surfaces.push(surface);
    runtime.setStorageSurface(surface);

    const uploadUrl = await surface.generateUploadUrl();
    const uploadResponse = await fetch(uploadUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: new Blob(["hello embedded"], { type: "text/plain" }),
    });
    const { storageId } = (await uploadResponse.json()) as {
      storageId: string;
    };

    expect(uploadResponse.ok).toBe(true);
    expect(typeof storageId).toBe("string");

    const metadata = await runtime.getStorageMetadata(storageId);
    expect(metadata).toMatchObject({
      size: 14,
      contentType: "text/plain",
    });

    const objectUrl = await surface.getUrl(storageId);
    expect(objectUrl).toMatch(/^blob:/);

    const repeatedObjectUrl = await surface.getUrl(storageId);
    expect(repeatedObjectUrl).toBe(objectUrl);

    const previewResponse = await fetch(objectUrl!);
    expect(previewResponse.headers.get("content-type")).toBe("text/plain");

    const content = await previewResponse.text();
    expect(content).toBe("hello embedded");
  });

  it("revokes cached URLs after the blob is deleted", async () => {
    const runtime = new EmbeddedRuntime({ modules: {} });
    runtimes.push(runtime);

    const surface = createBrowserStorageSurface(runtime);
    surfaces.push(surface);
    runtime.setStorageSurface(surface);

    const uploadUrl = await surface.generateUploadUrl();
    const uploadResponse = await fetch(uploadUrl, {
      method: "POST",
      body: new Blob(["delete-me"], { type: "text/plain" }),
    });
    const { storageId } = (await uploadResponse.json()) as {
      storageId: string;
    };

    const objectUrl = await surface.getUrl(storageId);
    expect(objectUrl).toMatch(/^blob:/);

    runtime.db.startTransaction();
    runtime.db.delete("_storage", storageId as any);
    runtime.db.deleteBlob(storageId);
    runtime.db.commit();

    await expect(surface.getUrl(storageId)).resolves.toBeNull();

    const recreated = await surface.getUrl(storageId);
    expect(recreated).toBeNull();
  });

  it("expires upload URLs after first successful use", async () => {
    const runtime = new EmbeddedRuntime({ modules: {} });
    runtimes.push(runtime);

    const surface = createBrowserStorageSurface(runtime);
    surfaces.push(surface);
    runtime.setStorageSurface(surface);

    const uploadUrl = await surface.generateUploadUrl();

    const first = await fetch(uploadUrl, {
      method: "POST",
      body: new Blob(["once"]),
    });
    const second = await fetch(uploadUrl, {
      method: "POST",
      body: new Blob(["twice"]),
    });

    expect(first.ok).toBe(true);
    expect(second.status).toBe(404);
  });

  it("rejects non-POST upload requests", async () => {
    const runtime = new EmbeddedRuntime({ modules: {} });
    runtimes.push(runtime);

    const surface = createBrowserStorageSurface(runtime);
    surfaces.push(surface);
    runtime.setStorageSurface(surface);

    const uploadUrl = await surface.generateUploadUrl();
    const response = await fetch(uploadUrl, { method: "GET" });
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(405);
    expect(body.error).toMatch(/only accepts POST/);
  });
});
