import {
  installInMemoryTracing,
  type BufferedSpan,
  type BufferingTracingHandle,
} from "@robelest/convex-embedded";

let handle: BufferingTracingHandle | null = null;

export function ensureTracingInstalled(): BufferingTracingHandle {
  if (handle === null) {
    handle = installInMemoryTracing({ capacity: 4000 });
  }
  return handle;
}

export type { BufferedSpan, BufferingTracingHandle };
