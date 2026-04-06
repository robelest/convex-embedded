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

export function createEncryptedStorage(
  storage: StorageAdapter,
  options: EncryptionOptions,
): StorageAdapter {
  return {
    async getDocuments(): Promise<StoredDocumentWithTable[]> {
      const rows = await storage.getDocuments();
      return Promise.all(
        rows.map(async ({ doc, tableName }) => ({
          doc: await decryptDocument(doc, options),
          tableName,
        })),
      );
    },

    async getDocumentsByTable(tableName: string): Promise<StoredDocument[]> {
      const docs = await storage.getDocumentsByTable(tableName);
      return Promise.all(docs.map((doc) => decryptDocument(doc, options)));
    },

    getMeta: () => storage.getMeta(),

    getBlobs: async () => {
      const entries = await storage.getBlobs();
      return Promise.all(
        entries.map(async ({ id, blob }) => {
          const text = await blob.text();
          const envelope = JSON.parse(text) as EncryptedEnvelope;
          const bytes = await decryptJson<number[]>(envelope, options);
          return { id, blob: new Blob([Uint8Array.from(bytes)]) };
        }),
      );
    },

    commit: async (batch: CommitBatch) => {
      const puts = await Promise.all(
        batch.puts.map(async ({ doc, tableName }) => ({
          tableName,
          doc: (await encryptDocument(
            doc,
            options,
          )) as unknown as StoredDocument,
        })),
      );
      await storage.commit({ ...batch, puts });
    },

    storeBlob: async (id: string, blob: Blob) => {
      const keyMaterial = await options.getActiveKey({
        identityKey: options.getIdentityKey(),
      });
      const buffer = await blob.arrayBuffer();
      const envelope = await encryptJson(
        Array.from(new Uint8Array(buffer)),
        keyMaterial,
        options.getIdentityKey(),
        options.crypto,
      );
      await storage.storeBlob(id, new Blob([JSON.stringify(envelope)]));
    },

    deleteBlob: (id: string) => storage.deleteBlob(id),
    clear: () => storage.clear(),
    close: async () => {
      await storage.close?.();
    },
  };
}
