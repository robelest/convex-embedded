import { markRoute } from "@/client/routing/metadata";
import { bindTable, bindTableRuntime } from "@/server/runtime";
import {
  embeddedTable,
  getTableRegistry,
  _resetRegistry,
  schema,
  define,
  prose,
  register,
  counter,
  set,
  omit,
  createConflict,
  isCrdtField,
  getCrdtType,
} from "@/server/schema";
import {
  PENDING_REPLAY_META,
  REMOTE_META,
  RESOLVE_QUERY_META,
  STORAGE_UPLOAD_URL_META,
} from "@/shared/symbols";
import type {
  PendingReplayMeta,
  PendingReplayMigrationContext,
  PendingReplayMigrationResult,
  PendingReplayMigrationStep,
  RemoteMeta,
  ResolveQueryMeta,
  RouteMode,
  StorageUploadUrlMeta,
} from "@/shared/symbols";

export {
  bindTable,
  bindTableRuntime,
  embeddedTable,
  getTableRegistry,
  _resetRegistry,
  schema,
  define,
  prose,
  register,
  counter,
  set,
  omit,
  createConflict,
  isCrdtField,
  getCrdtType,
  PENDING_REPLAY_META,
  REMOTE_META,
  RESOLVE_QUERY_META,
  STORAGE_UPLOAD_URL_META,
};

export type {
  Definition,
  EmbeddedTableHandle,
  ComponentBinding,
  DefineOptions,
  LocalTableMigrationStep,
  RegisterOptions,
} from "@/server/schema";

export type {
  PendingReplayMeta,
  PendingReplayMigrationContext,
  PendingReplayMigrationResult,
  PendingReplayMigrationStep,
  RemoteMeta,
  ResolveQueryMeta,
  RouteMode,
  StorageUploadUrlMeta,
};

export function localOnly<T>(fn: T): T {
  return markRoute(fn, "local");
}

export function remoteOnly<T>(fn: T): T {
  return markRoute(fn, "remote");
}

export function storageUploadUrl<T>(fn: T): T {
  Object.defineProperty(fn as object, STORAGE_UPLOAD_URL_META, {
    value: { __brand: "convex-embedded:storageUploadUrlMeta" },
    enumerable: false,
    configurable: false,
  });
  return fn;
}
