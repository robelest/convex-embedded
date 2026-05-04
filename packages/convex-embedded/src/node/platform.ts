import { resolve } from "node:path";

import { openNodeStorage } from "@/node/sqlite/adapter";
import { createAmbientCryptoProvider } from "@/runtime/crypto";
import {
  createAmbientConnectivityAdapter,
  createNoopWriteBroadcast,
  type EmbeddedPlatformAdapter,
} from "@/runtime/platform";
import { createLogger } from "@/shared/logger";

const log = createLogger("node");

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
    async openStorage({ name, runtime }) {
      const filename =
        options.databasePath ?? resolve(process.cwd(), `${name}.sqlite`);
      log.debug(`starting sqlite storage for ${filename}`);
      return await openNodeStorage({
        filename,
        userTableSpecs: runtime.getUserTableSpecs() ?? undefined,
      });
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
