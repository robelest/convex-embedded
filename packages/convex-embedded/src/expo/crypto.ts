import { gcm } from "@noble/ciphers/aes.js";
import * as ExpoCrypto from "expo-crypto";

import type { EmbeddedCryptoProvider } from "@/runtime/crypto";

export function createExpoCryptoProvider(): EmbeddedCryptoProvider {
  return {
    randomUUID() {
      return ExpoCrypto.randomUUID();
    },
    getRandomValues(bytes) {
      return ExpoCrypto.getRandomValues(bytes);
    },
    async sha256(data) {
      const input = data instanceof Uint8Array ? data : new Uint8Array(data);
      const digest = await ExpoCrypto.digest(
        ExpoCrypto.CryptoDigestAlgorithm.SHA256,
        input.buffer.slice(
          input.byteOffset,
          input.byteOffset + input.byteLength,
        ) as ArrayBuffer,
      );
      return new Uint8Array(digest);
    },
    async encryptAesGcm({ key, plaintext, nonce, additionalData }) {
      return gcm(asKeyBytes(key), nonce, additionalData).encrypt(plaintext);
    },
    async decryptAesGcm({ key, ciphertext, nonce, additionalData }) {
      return gcm(asKeyBytes(key), nonce, additionalData).decrypt(ciphertext);
    },
  };
}

function asKeyBytes(key: unknown): Uint8Array {
  if (key instanceof Uint8Array) {
    return key;
  }
  if (key instanceof ArrayBuffer) {
    return new Uint8Array(key);
  }
  throw new Error(
    "[convex-embedded] Expo encryption keys must be provided as Uint8Array or ArrayBuffer.",
  );
}
