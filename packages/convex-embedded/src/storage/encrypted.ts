/**
 * Encrypted storage adapter wrapper.
 *
 * Wraps a storage adapter so documents and blobs are encrypted at rest using
 * caller-supplied key management hooks.
 *
 * @internal
 */

import {
  PersistenceAdapter,
  type CommitBatch,
  type DatabaseMeta,
  type StoredDocumentWithTable,
} from "@/persistence/adapter";
import type { EmbeddedCryptoProvider } from "@/runtime/crypto";
import type { StoredDocument } from "@/runtime/db/types";
import { decodeBase64, encodeBase64 } from "@/shared/base64";

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
  encoding: "json" | "bytes";
  nonce: string;
  ciphertext: string;
};

type EncryptedStoredDocument = {
  _id: string;
  _creationTime: number;
  __encrypted: EncryptedEnvelope;
};

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

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
    encoding: "json",
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

async function encryptBytes(
  value: Uint8Array,
  keyMaterial: KeyMaterial,
  identityKey: string | null,
  crypto: EmbeddedCryptoProvider,
): Promise<EncryptedEnvelope> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.encryptAesGcm({
    key: keyMaterial.key,
    plaintext: value,
    nonce,
    additionalData: new TextEncoder().encode(identityKey ?? "anonymous"),
  });

  return {
    version: 1,
    keyId: keyMaterial.keyId,
    identityKey,
    encoding: "bytes",
    nonce: encodeBase64(nonce),
    ciphertext: encodeBase64(ciphertext),
  };
}

async function decryptBytes(
  envelope: EncryptedEnvelope,
  options: EncryptionOptions,
): Promise<Uint8Array> {
  const key = await options.getKey({
    keyId: envelope.keyId,
    identityKey: envelope.identityKey,
  });
  if (!key) {
    throw new Error(`Missing encryption key for ${envelope.keyId}`);
  }

  return options.crypto.decryptAesGcm({
    key,
    nonce: decodeBase64(envelope.nonce),
    ciphertext: decodeBase64(envelope.ciphertext),
    additionalData: new TextEncoder().encode(
      envelope.identityKey ?? "anonymous",
    ),
  });
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
class EncryptedAdapter extends PersistenceAdapter {
  constructor(
    private readonly inner: PersistenceAdapter,
    private readonly options: EncryptionOptions,
  ) {
    super();
  }

  async listAll(): Promise<StoredDocumentWithTable[]> {
    const rows = await this.inner.listAll();
    const results: StoredDocumentWithTable[] = [];
    for (const { doc, tableName } of rows) {
      results.push({
        doc: await decryptDocument(doc, this.options),
        tableName,
      });
    }
    return results;
  }

  async list(tableName: string): Promise<StoredDocument[]> {
    const docs = await this.inner.list(tableName);
    const results: StoredDocument[] = [];
    for (const doc of docs) {
      results.push(await decryptDocument(doc, this.options));
    }
    return results;
  }

  meta(): Promise<DatabaseMeta | null> {
    return this.inner.meta();
  }

  async commit(batch: CommitBatch): Promise<void> {
    const puts: StoredDocumentWithTable[] = [];
    for (const { doc, tableName } of batch.puts) {
      const encrypted = await encryptDocument(doc, this.options);
      puts.push({ tableName, doc: encrypted as unknown as StoredDocument });
    }
    await this.inner.commit({ ...batch, puts });
  }

  async clear(): Promise<void> {
    await this.inner.clear();
  }

  async listBlobs(): Promise<Array<{ id: string; blob: Blob }>> {
    const entries = await this.inner.listBlobs();
    const results: Array<{ id: string; blob: Blob }> = [];
    for (const { id, blob } of entries) {
      const text = await blob.text();
      const envelope = JSON.parse(text) as EncryptedEnvelope;
      const bytes = await decryptBytes(envelope, this.options);
      results.push({ id, blob: new Blob([toArrayBuffer(bytes)]) });
    }
    return results;
  }

  async getBlob(id: string): Promise<Blob | null> {
    const encrypted = await this.inner.getBlob(id);
    if (encrypted === null) return null;
    const text = await encrypted.text();
    const envelope = JSON.parse(text) as EncryptedEnvelope;
    const bytes = await decryptBytes(envelope, this.options);
    return new Blob([toArrayBuffer(bytes)]);
  }

  async putBlob(id: string, blob: Blob): Promise<void> {
    const identityKey = this.options.getIdentityKey();
    const [keyMaterial, buffer] = await Promise.all([
      this.options.getActiveKey({ identityKey }),
      blob.arrayBuffer(),
    ]);
    const envelope = await encryptBytes(
      new Uint8Array(buffer),
      keyMaterial,
      identityKey,
      this.options.crypto,
    );
    await this.inner.putBlob(id, new Blob([JSON.stringify(envelope)]));
  }

  async deleteBlob(id: string): Promise<void> {
    await this.inner.deleteBlob(id);
  }

  async close(): Promise<void> {
    await this.inner.close();
  }
}

export function createEncryptedStorage(
  storage: PersistenceAdapter,
  options: EncryptionOptions,
): PersistenceAdapter {
  return new EncryptedAdapter(storage, options);
}
