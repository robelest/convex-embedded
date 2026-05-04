import "react-native-get-random-values";
import { gcm } from "@noble/ciphers/aes.js";
import { sha256 } from "@noble/hashes/sha2.js";

import type { EmbeddedCryptoProvider } from "@/runtime/crypto";
import { formatUuidV4 } from "@/runtime/crypto";

export function createExpoCryptoProvider(): EmbeddedCryptoProvider {
  const crypto = globalThis.crypto;
  if (!crypto) {
    throw new Error(
      "[convex-embedded] No React Native crypto polyfill is available.",
    );
  }

  return {
    randomUUID() {
      return typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : formatUuidV4(
            crypto.getRandomValues(new Uint8Array(16)) as Uint8Array,
          );
    },
    getRandomValues(bytes) {
      return crypto.getRandomValues(
        bytes as Uint8Array<ArrayBuffer>,
      ) as Uint8Array;
    },
    async sha256(data) {
      const input = data instanceof Uint8Array ? data : new Uint8Array(data);
      return sha256(input);
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
