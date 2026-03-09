/**
 * Fake in-memory blob storage.
 *
 * Provides a minimal `storage` implementation for the embedded runtime,
 * storing blobs in a `Map` and returning synthetic IDs / URLs.
 */

// ---------------------------------------------------------------------------
// BlobStore
// ---------------------------------------------------------------------------

/**
 * In-memory blob store that mirrors the Convex storage API surface.
 *
 * Blobs are held in memory for the lifetime of the runtime — there is
 * no persistence across page reloads.
 */
export class BlobStore {
  private _blobs: Map<string, Blob> = new Map();
  private _nextId = 1;

  /**
   * Store a blob and return a synthetic storage ID.
   */
  async store(blob: Blob): Promise<string> {
    const storageId = `storage:${this._nextId++}`;
    this._blobs.set(storageId, blob);
    return storageId;
  }

  /**
   * Retrieve a previously stored blob, or `null` if not found.
   */
  get(storageId: string): Blob | null {
    return this._blobs.get(storageId) ?? null;
  }

  /**
   * Delete a stored blob. Returns `true` if the blob existed.
   */
  delete(storageId: string): boolean {
    return this._blobs.delete(storageId);
  }

  /**
   * Get a fake URL for a stored blob, or `null` if not found.
   *
   * In a real Convex deployment this would be a signed URL pointing at
   * cloud storage. Here we return a synthetic `blob://` URL.
   */
  getUrl(storageId: string): string | null {
    if (!this._blobs.has(storageId)) return null;
    return `blob://embedded.local/${storageId}`;
  }

  /**
   * Generate a fake upload URL.
   *
   * In the real Convex runtime this URL is used by the client to upload
   * a blob via HTTP. In the embedded runtime the upload flow is handled
   * in-process, so we return a placeholder URL.
   */
  generateUploadUrl(): string {
    return `blob://embedded.local/upload/${this._nextId++}`;
  }
}
