/**
 * Encrypted storage adapter wrapper.
 *
 * Wraps a storage adapter so documents and blobs are encrypted at rest using
 * caller-supplied key management hooks.
 *
 * @internal
 */
import { Fx } from "@robelest/fx";

import type { EmbeddedCryptoProvider } from "@/runtime/crypto";
import type { StoredDocument } from "@/runtime/db/types";
import { decodeBase64, encodeBase64 } from "@/shared/base64";
import type {
  CommitBatch,
  StorageAdapter,
  StoredDocumentWithTable,
} from "@/storage/adapter";

type KeyMaterial = {
  keyId: string;
  key: unknown;
};

export interface EncryptionOptions {
  crypto: EmbeddedCryptoProvider;
  getActiveKey: (ctx: { identityKey: string | null }) => Promise<KeyMaterial>;
  getKey: (ctx: {
    keyId: string;
    identityKey: string | null;
  }) => Promise<unknown>;
  getIdentityKey: () => string | null;
}

type EncryptedEnvelope = {
  version: 1;
  keyId: string;
  identityKey: string | null;
  nonce: string;
  ciphertext: string;
};

type EncryptedStoredDocument = {
  _id: string;
  _creationTime: number;
  __encrypted: EncryptedEnvelope;
};

async function encryptJson(
  value: unknown,
  keyMaterial: KeyMaterial,
  identityKey: string | null,
  crypto: EmbeddedCryptoProvider,
): Promise<EncryptedEnvelope> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = await crypto.encryptAesGcm({
    key: keyMaterial.key,
    plaintext,
    nonce,
    additionalData: new TextEncoder().encode(identityKey ?? "anonymous"),
  });

  return {
    version: 1,
    keyId: keyMaterial.keyId,
    identityKey,
    nonce: encodeBase64(nonce),
    ciphertext: encodeBase64(ciphertext),
  };
}

async function decryptJson<T>(
  envelope: EncryptedEnvelope,
  options: EncryptionOptions,
): Promise<T> {
  const key = await options.getKey({
    keyId: envelope.keyId,
    identityKey: envelope.identityKey,
  });
  if (!key) {
    throw new Error(`Missing encryption key for ${envelope.keyId}`);
  }

  const plaintext = await options.crypto.decryptAesGcm({
    key,
    nonce: decodeBase64(envelope.nonce),
    ciphertext: decodeBase64(envelope.ciphertext),
    additionalData: new TextEncoder().encode(
      envelope.identityKey ?? "anonymous",
    ),
  });

  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}

async function encryptDocument(
  doc: StoredDocument,
  options: EncryptionOptions,
): Promise<EncryptedStoredDocument> {
  const identityKey = options.getIdentityKey();
  const keyMaterial = await options.getActiveKey({ identityKey });
  return {
    _id: String(doc._id),
    _creationTime: doc._creationTime,
    __encrypted: await encryptJson(
      doc,
      keyMaterial,
      identityKey,
      options.crypto,
    ),
  };
}

async function decryptDocument(
  doc: StoredDocument,
  options: EncryptionOptions,
): Promise<StoredDocument> {
  const encrypted = (doc as unknown as EncryptedStoredDocument).__encrypted;
  if (!encrypted) {
    return doc;
  }
  return decryptJson<StoredDocument>(encrypted, options);
}

/**
 * Wrap a storage adapter with encryption-at-rest behavior.
 *
 * @param storage - Underlying storage adapter used for persistence.
 * @param options - Encryption key management and crypto hooks.
 * @returns A storage adapter that encrypts documents and blobs before writing.
 *
 * @see EncryptionOptions
 */
export function createEncryptedStorage(
  storage: StorageAdapter,
  options: EncryptionOptions,
): StorageAdapter {
  return {
    async getDocuments(): Promise<StoredDocumentWithTable[]> {
      return Fx.run(
        Fx.from({
          ok: () => storage.getDocuments(),
          err: (error) => error as Error,
        }).pipe(
          Fx.chain((rows) =>
            Fx.each(rows, ({ doc, tableName }) =>
              Fx.from({
                ok: () => decryptDocument(doc, options),
                err: (error) => error as Error,
              }).pipe(Fx.map((decrypted) => ({ doc: decrypted, tableName }))),
            ),
          ),
        ),
      );
    },

    async getDocumentsByTable(tableName: string): Promise<StoredDocument[]> {
      return Fx.run(
        Fx.from({
          ok: () => storage.getDocumentsByTable(tableName),
          err: (error) => error as Error,
        }).pipe(
          Fx.chain((docs) =>
            Fx.each(docs, (doc) =>
              Fx.from({
                ok: () => decryptDocument(doc, options),
                err: (error) => error as Error,
              }),
            ),
          ),
        ),
      );
    },

    getMeta: () => storage.getMeta(),

    getBlobs: async () => {
      return Fx.run(
        Fx.from({
          ok: () => storage.getBlobs(),
          err: (error) => error as Error,
        }).pipe(
          Fx.chain((entries) =>
            Fx.each(entries, ({ id, blob }) =>
              Fx.from({
                ok: () => blob.text(),
                err: (error) => error as Error,
              }).pipe(
                Fx.map((text) => JSON.parse(text) as EncryptedEnvelope),
                Fx.chain((envelope) =>
                  Fx.from({
                    ok: () => decryptJson<number[]>(envelope, options),
                    err: (error) => error as Error,
                  }),
                ),
                Fx.map((bytes) => ({
                  id,
                  blob: new Blob([Uint8Array.from(bytes)]),
                })),
              ),
            ),
          ),
        ),
      );
    },

    commit: async (batch: CommitBatch) => {
      const puts = await Fx.run(
        Fx.each(batch.puts, ({ doc, tableName }) =>
          Fx.from({
            ok: () => encryptDocument(doc, options),
            err: (error) => error as Error,
          }).pipe(
            Fx.map((encrypted) => ({
              tableName,
              doc: encrypted as unknown as StoredDocument,
            })),
          ),
        ),
      );
      await Fx.run(
        Fx.from({
          ok: () => storage.commit({ ...batch, puts }),
          err: (error) => error as Error,
        }),
      );
    },

    storeBlob: async (id: string, blob: Blob) => {
      const identityKey = options.getIdentityKey();
      const [keyMaterial, buffer] = await Fx.run(
        Fx.zip(
          Fx.from({
            ok: () => options.getActiveKey({ identityKey }),
            err: (error) => error as Error,
          }),
          Fx.from({
            ok: () => blob.arrayBuffer(),
            err: (error) => error as Error,
          }),
        ),
      );
      const envelope = await Fx.run(
        Fx.from({
          ok: () =>
            encryptJson(
              Array.from(new Uint8Array(buffer)),
              keyMaterial,
              identityKey,
              options.crypto,
            ),
          err: (error) => error as Error,
        }),
      );
      await Fx.run(
        Fx.from({
          ok: () => storage.storeBlob(id, new Blob([JSON.stringify(envelope)])),
          err: (error) => error as Error,
        }),
      );
    },

    deleteBlob: (id: string) => storage.deleteBlob(id),
    clear: () => storage.clear(),
    close: async () => {
      await Fx.run(
        Fx.from({
          ok: () => storage.close?.() ?? Promise.resolve(),
          err: (error) => error as Error,
        }),
      );
    },
  };
}
