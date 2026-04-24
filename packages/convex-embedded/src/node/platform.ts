import { resolve } from "node:path";

import { openNodePersistence } from "@/node/sqlite/adapter";
import { createAmbientCryptoProvider } from "@/runtime/crypto";
import {
  createAmbientConnectivityAdapter,
  createNoopWriteBroadcast,
  type EmbeddedPlatformAdapter,
} from "@/runtime/platform";

export interface NodePlatformOptions {
  databasePath?: string;
  connectivity?: EmbeddedPlatformAdapter["connectivity"];
  processorIdentity?: EmbeddedPlatformAdapter["processorIdentity"];
}

export function createNodePlatformAdapter(
  options: NodePlatformOptions = {},
): EmbeddedPlatformAdapter {
  const platformCrypto = createAmbientCryptoProvider();
  const connectivity =
    options.connectivity ?? createAmbientConnectivityAdapter();

  return {
    crypto: platformCrypto,
    async openPersistence({ name }) {
      const filename =
        options.databasePath ?? resolve(process.cwd(), `${name}.sqlite`);
      console.info(
        `[convex-embedded] starting node sqlite persistence for ${filename}`,
      );
      return await openNodePersistence({ filename });
    },
    createWriteBroadcast() {
      return createNoopWriteBroadcast();
    },
    connectivity,
    processorIdentity: options.processorIdentity ?? {
      getProcessorId({ name }) {
        return `${name}:node:${platformCrypto.randomUUID()}`;
      },
    },
  };
}
