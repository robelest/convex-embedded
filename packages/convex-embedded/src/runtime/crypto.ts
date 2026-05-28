import { encodeBase64 } from "@/shared/base64";

export interface EmbeddedCryptoProvider {
  randomUUID(): string;
  getRandomValues(bytes: Uint8Array): Uint8Array;
  sha256(data: Uint8Array | ArrayBuffer): Promise<Uint8Array>;
  encryptAesGcm(input: {
    key: unknown;
    plaintext: Uint8Array;
    nonce: Uint8Array;
    additionalData?: Uint8Array;
  }): Promise<Uint8Array>;
  decryptAesGcm(input: {
    key: unknown;
    ciphertext: Uint8Array;
    nonce: Uint8Array;
    additionalData?: Uint8Array;
  }): Promise<Uint8Array>;
}

export function createAmbientCryptoProvider(): EmbeddedCryptoProvider {
  const webCrypto = globalThis.crypto;
  if (!webCrypto) {
    throw new Error(
      "[convex-embedded] No ambient crypto implementation is available. Provide a platform crypto adapter.",
    );
  }

  return {
    randomUUID() {
      return webCrypto.randomUUID();
    },
    getRandomValues(bytes) {
      return webCrypto.getRandomValues(
        bytes as Uint8Array<ArrayBuffer>,
      ) as Uint8Array;
    },
    async sha256(data) {
      const digest = await webCrypto.subtle.digest(
        "SHA-256",
        toBufferSource(data),
      );
      return new Uint8Array(digest);
    },
    async encryptAesGcm({ key, plaintext, nonce, additionalData }) {
      const ciphertext = await webCrypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: toBufferSource(nonce),
          additionalData:
            additionalData === undefined
              ? undefined
              : toBufferSource(additionalData),
        },
        key as CryptoKey,
        toBufferSource(plaintext),
      );
      return new Uint8Array(ciphertext);
    },
    async decryptAesGcm({ key, ciphertext, nonce, additionalData }) {
      const plaintext = await webCrypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: toBufferSource(nonce),
          additionalData:
            additionalData === undefined
              ? undefined
              : toBufferSource(additionalData),
        },
        key as CryptoKey,
        toBufferSource(ciphertext),
      );
      return new Uint8Array(plaintext);
    },
  };
}

export async function blobShaBase64(
  blob: Blob,
  crypto: EmbeddedCryptoProvider,
): Promise<string> {
  const arrayBuffer = await blob.arrayBuffer();
  const digest = await crypto.sha256(arrayBuffer);
  return encodeBase64(digest);
}

export function formatUuidV4(bytes: Uint8Array): string {
  if (bytes.length !== 16) {
    throw new Error("UUID v4 requires exactly 16 random bytes");
  }

  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join(""),
  ].join("-");
}

function toBufferSource(data: Uint8Array | ArrayBuffer): ArrayBuffer {
  if (data instanceof Uint8Array) {
    return data.buffer.slice(
      data.byteOffset,
      data.byteOffset + data.byteLength,
    ) as ArrayBuffer;
  }
  return data;
}
