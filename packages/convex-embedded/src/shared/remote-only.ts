export const REMOTE_ONLY = Symbol.for("convex-embedded:remoteOnly");

interface RemoteOnlyMeta {
  readonly __brand: "convex-embedded:remoteOnly";
}

const REMOTE_ONLY_META: RemoteOnlyMeta = {
  __brand: "convex-embedded:remoteOnly",
};

function isTaggable(value: unknown): value is object {
  return (
    typeof value === "function" || (typeof value === "object" && value !== null)
  );
}

export function markRemoteOnly<T>(value: T): T {
  if (!isTaggable(value)) {
    throw new Error(
      "remoteOnly() expects a Convex function export (query/mutation/action)",
    );
  }

  Object.defineProperty(value, REMOTE_ONLY, {
    value: REMOTE_ONLY_META,
    enumerable: false,
    configurable: false,
  });

  return value;
}

export function isRemoteOnly(value: unknown): boolean {
  if (!isTaggable(value)) return false;
  const meta = (value as any)[REMOTE_ONLY] as RemoteOnlyMeta | undefined;
  return meta?.__brand === "convex-embedded:remoteOnly";
}
