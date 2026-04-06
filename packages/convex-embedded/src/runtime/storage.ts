export interface StorageSurface {
  getUrl(storageId: string): Promise<string | null>;
  generateUploadUrl(): Promise<string>;
}

export function missingStorageSurfaceError(
  operation: "getUrl" | "generateUploadUrl",
): Error {
  return new Error(
    `[convex-embedded] Local storage ${operation} is not available in this runtime. ` +
      "Use a platform surface such as @robelest/convex-embedded/browser or move the boundary remote.",
  );
}
