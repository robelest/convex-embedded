import type { PersistenceAdapter } from "@/persistence/adapter";
import type { EmbeddedCryptoProvider } from "@/runtime/crypto";
import type { EmbeddedRuntime } from "@/runtime/embedded";
import type { StorageSurface } from "@/runtime/storage";
import type { EncryptionOptions } from "@/storage/encrypted";

export type SessionEvent = { type: "authChanged" };

export interface SessionBroadcast {
  notify(event: SessionEvent): void;
  onNotification(callback: (event: SessionEvent) => void): () => void;
  close(): void;
}

export interface WriteBroadcast {
  notify(tablesWritten: Set<string>): void;
  onNotification(callback: (tablesWritten: Set<string>) => void): () => void;
  close(): void;
}

export function createNoopWriteBroadcast(): WriteBroadcast {
  return {
    notify() {},
    onNotification() {
      return () => {};
    },
    close() {},
  };
}

export interface ConnectivityAdapter {
  isOnline(): boolean;
  onOnline?(callback: () => void): () => void;
  onOffline?(callback: () => void): () => void;
  close?(): void;
}

export function createAmbientConnectivityAdapter(): ConnectivityAdapter {
  return {
    isOnline() {
      const hasNavigator =
        typeof globalThis !== "undefined" && "navigator" in globalThis;
      const nav = hasNavigator
        ? (globalThis as { navigator?: { onLine?: boolean } }).navigator
        : undefined;
      return nav?.onLine !== false;
    },
    onOnline(callback) {
      if (typeof globalThis.addEventListener !== "function") {
        return () => {};
      }
      globalThis.addEventListener("online", callback);
      return () => globalThis.removeEventListener("online", callback);
    },
    onOffline(callback) {
      if (typeof globalThis.addEventListener !== "function") {
        return () => {};
      }
      globalThis.addEventListener("offline", callback);
      return () => globalThis.removeEventListener("offline", callback);
    },
  };
}

export function isConnectivityOffline(
  connectivity?: ConnectivityAdapter,
): boolean {
  return connectivity?.isOnline() === false;
}

export interface ProcessorIdentity {
  getProcessorId(input: { name: string }): string;
}

/**
 * Platform services required to assemble an embedded client outside the web.
 *
 * Browser, Electron, and Expo-style environments can all implement this
 * surface differently while reusing the same core runtime/client assembly.
 */
export interface EmbeddedPlatformAdapter {
  crypto?: EmbeddedCryptoProvider;
  openPersistence(input: {
    name: string;
    runtime: EmbeddedRuntime;
    encryption?: Omit<EncryptionOptions, "getIdentityKey">;
  }): Promise<PersistenceAdapter | null>;
  createSessionBroadcast?(input: { name: string }): SessionBroadcast;
  createWriteBroadcast?(input: { name: string }): WriteBroadcast;
  createStorageSurface?(input: {
    runtime: EmbeddedRuntime;
    name: string;
    crypto: EmbeddedCryptoProvider;
  }): (StorageSurface & { close(): void }) | null;
  connectivity?: ConnectivityAdapter;
  processorIdentity?: ProcessorIdentity;
}
