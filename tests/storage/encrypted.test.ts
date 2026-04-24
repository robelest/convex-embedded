import { OpaqueAdapter } from "@embedded/persistence/opaque/adapter";
import { createAmbientCryptoProvider } from "@embedded/runtime/crypto";
import { createEncryptedStorage } from "@embedded/storage/encrypted";
import { describe, expect, it } from "@tests/testkit";

const cryptoProvider = createAmbientCryptoProvider();

async function createKey() {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ]);
}

describe("createEncryptedStorage", () => {
  it("round-trips encrypted documents and blobs", async () => {
    const key = await createKey();
    const storage = createEncryptedStorage(new OpaqueAdapter(), {
      crypto: cryptoProvider,
      getActiveKey: async () => ({ keyId: "k1", key }),
      getKey: async ({ keyId }) => (keyId === "k1" ? key : null),
      getIdentityKey: () => "user:a",
    });

    await storage.commit({
      puts: [
        {
          tableName: "tasks",
          doc: {
            _id: "doc-1",
            _creationTime: 1,
            title: "Secret",
          } as any,
        },
      ],
      deletes: [],
      meta: { timestamp: 1, lastCreationTime: 1 },
    });
    await storage.putBlob("blob-1", new Blob([new Uint8Array([1, 2, 3])]));

    const docs = await storage.list("tasks");
    const blobs = await storage.listBlobs();

    expect(docs).toEqual([
      {
        _id: "doc-1",
        _creationTime: 1,
        title: "Secret",
      },
    ]);
    expect(new Uint8Array(await blobs[0]!.blob.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });

  it("fails cleanly when a key is unavailable", async () => {
    const key = await createKey();
    const base = new OpaqueAdapter();
    const encrypted = createEncryptedStorage(base, {
      crypto: cryptoProvider,
      getActiveKey: async () => ({ keyId: "k1", key }),
      getKey: async ({ keyId }) => (keyId === "k1" ? key : null),
      getIdentityKey: () => null,
    });

    await encrypted.commit({
      puts: [
        {
          tableName: "tasks",
          doc: { _id: "doc-1", _creationTime: 1, title: "Secret" } as any,
        },
      ],
      deletes: [],
      meta: { timestamp: 1, lastCreationTime: 1 },
    });

    const broken = createEncryptedStorage(base, {
      crypto: cryptoProvider,
      getActiveKey: async () => ({ keyId: "k2", key }),
      getKey: async () => null,
      getIdentityKey: () => null,
    });

    await expect(broken.listAll()).rejects.toThrow(/Missing encryption key/);
  });

  it("supports large encrypted blobs without stack overflow", async () => {
    const key = await createKey();
    const storage = createEncryptedStorage(new OpaqueAdapter(), {
      crypto: cryptoProvider,
      getActiveKey: async () => ({ keyId: "k1", key }),
      getKey: async ({ keyId }) => (keyId === "k1" ? key : null),
      getIdentityKey: () => "user:a",
    });

    const payload = new Uint8Array(256 * 1024);
    for (let index = 0; index < payload.length; index++) {
      payload[index] = index % 251;
    }
    await expect(
      storage.putBlob("blob-large", new Blob([payload])),
    ).resolves.toBeUndefined();

    const blobs = await storage.listBlobs();
    expect(new Uint8Array(await blobs[0]!.blob.arrayBuffer())).toEqual(payload);
  });
});
