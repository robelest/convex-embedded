import type { DocumentId } from "@embedded/runtime/db/types";
import { createEmbeddedRuntime } from "@embedded/runtime/embedded";
import {
  createBrowserStorageSurface,
  createBrowserUploadFetch,
} from "@resolve/browser/storage";
import { describe, expect, it } from "@tests/testkit";

const uploadFetch = createBrowserUploadFetch();

function createSurface(track: <T extends { close: () => unknown }>(c: T) => T) {
  const runtime = track({
    runtime: createEmbeddedRuntime({ convex: { modules: {} } }),
    close() {
      this.runtime.shutdown();
    },
  }).runtime;

  const surface = track(createBrowserStorageSurface(runtime));
  runtime.setStorageSurface(surface);

  return { runtime, surface };
}

async function uploadBlob(
  surface: ReturnType<typeof createBrowserStorageSurface>,
  blob: Blob,
  init?: RequestInit,
): Promise<{ response: Response; storageId: string }> {
  const uploadUrl = await surface.generateUploadUrl();
  const response = await uploadFetch(uploadUrl, {
    method: "POST",
    body: blob,
    ...init,
  });
  const { storageId } = (await response.clone().json()) as {
    storageId: string;
  };
  return { response, storageId };
}

describe("browser storage surface", () => {
  it("supports local upload URLs and blob-backed getUrl", async ({ track }) => {
    const { runtime, surface } = createSurface(track);

    const { response, storageId } = await uploadBlob(
      surface,
      new Blob(["hello embedded"], { type: "text/plain" }),
      { headers: { "Content-Type": "text/plain" } },
    );

    expect(response.ok).toBe(true);
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

  it("revokes cached URLs after the blob is deleted", async ({ track }) => {
    const { runtime, surface } = createSurface(track);

    const { storageId } = await uploadBlob(
      surface,
      new Blob(["delete-me"], { type: "text/plain" }),
    );

    const objectUrl = await surface.getUrl(storageId);
    expect(objectUrl).toMatch(/^blob:/);

    runtime.db.startTransaction();
    runtime.db.delete("_storage", storageId as DocumentId);
    runtime.db.deleteBlob(storageId);
    runtime.db.commit();

    await expect(surface.getUrl(storageId)).resolves.toBeNull();
    await expect(surface.getUrl(storageId)).resolves.toBeNull();
  });

  it("expires upload URLs after first successful use", async ({ track }) => {
    const { surface } = createSurface(track);

    const uploadUrl = await surface.generateUploadUrl();
    const first = await uploadFetch(uploadUrl, {
      method: "POST",
      body: new Blob(["once"]),
    });
    const second = await uploadFetch(uploadUrl, {
      method: "POST",
      body: new Blob(["twice"]),
    });

    expect(first.ok).toBe(true);
    expect(second.status).toBe(404);
  });

  it("rejects non-POST upload requests", async ({ track }) => {
    const { surface } = createSurface(track);

    const uploadUrl = await surface.generateUploadUrl();
    const response = await uploadFetch(uploadUrl, { method: "GET" });
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(405);
    expect(body.error).toMatch(/only accepts POST/);
  });
});
