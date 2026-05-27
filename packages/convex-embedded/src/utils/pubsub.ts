import { createLogger } from "@/shared/logger";

const log = createLogger("pubsub");

export interface PubSub<T> {
  publish(value: T): void;
  subscribe(fn: (value: T) => void): () => void;
  shutdown(): void;
  readonly isClosed: boolean;
  readonly subscriberCount: number;
}

export function createPubSub<T>(): PubSub<T> {
  const subs = new Set<(value: T) => void>();
  let closed = false;

  return {
    publish(value: T): void {
      if (closed) return;
      for (const fn of subs) {
        try {
          fn(value);
        } catch (err) {
          log.warn("pubsub listener error", err);
        }
      }
    },
    subscribe(fn: (value: T) => void): () => void {
      if (closed) return () => {};
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
    shutdown(): void {
      closed = true;
      subs.clear();
    },
    get isClosed(): boolean {
      return closed;
    },
    get subscriberCount(): number {
      return subs.size;
    },
  };
}
