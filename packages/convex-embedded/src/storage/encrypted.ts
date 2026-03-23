import type { StoredDocument } from "@/core/types";
import type {
  CommitBatch,
  StorageAdapter,
  StoredDocumentWithTable,
} from "@/storage/adapter";

type KeyMaterial = {
  keyId: string;
  key: CryptoKey;
};

export interface EncryptionOptions {
  getActiveKey: (ctx: { identityKey: string | null }) => Promise<KeyMaterial>;
  getKey: (ctx: {
    keyId: string;
    identityKey: string | null;
  }) => Promise<CryptoKey | null>;
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

function toBase64(bytes: Uint8Array): string {
  if (typeof btoa !== "function") {
    throw new Error("Base64 encoding is unavailable in this runtime");
  }

  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  if (typeof atob !== "function") {
    throw new Error("Base64 decoding is unavailable in this runtime");
  }
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

async function encryptJson(
  value: unknown,
  keyMaterial: KeyMaterial,
  identityKey: string | null,
): Promise<EncryptedEnvelope> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: nonce,
      additionalData: new TextEncoder().encode(identityKey ?? "anonymous"),
    },
    keyMaterial.key,
    plaintext,
  );

  return {
    version: 1,
    keyId: keyMaterial.keyId,
    identityKey,
    nonce: toBase64(nonce),
    ciphertext: toBase64(new Uint8Array(ciphertext)),
  };
}

async function decryptJson<T>(
  envelope: EncryptedEnvelope,
  getKey: EncryptionOptions["getKey"],
): Promise<T> {
  const key = await getKey({
    keyId: envelope.keyId,
    identityKey: envelope.identityKey,
  });
  if (!key) {
    throw new Error(`Missing encryption key for ${envelope.keyId}`);
  }

  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: fromBase64(envelope.nonce),
      additionalData: new TextEncoder().encode(
        envelope.identityKey ?? "anonymous",
      ),
    },
    key,
    fromBase64(envelope.ciphertext),
  );

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
    __encrypted: await encryptJson(doc, keyMaterial, identityKey),
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
  return decryptJson<StoredDocument>(encrypted, options.getKey);
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
          const bytes = await decryptJson<number[]>(envelope, options.getKey);
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
      );
      await storage.storeBlob(id, new Blob([JSON.stringify(envelope)]));
    },

    deleteBlob: (id: string) => storage.deleteBlob(id),
    clear: () => storage.clear(),
    close: () => storage.close?.(),
  };
}
