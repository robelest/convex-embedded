import type { StoreMigrationManifest } from "./types";

export const PENDING_UPLOADS_STORE_MIGRATIONS: StoreMigrationManifest = {
  store: "pendingUploadsQueue",
  scope: "identity",
  version: 1,
};
