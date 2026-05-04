export class PubSub<T> {
  private subs = new Set<(value: T) => void>();
  private closed = false;

  publish(value: T): void {
    if (this.closed) return;
    for (const fn of this.subs) {
      try {
        fn(value);
      } catch {}
    }
  }

  subscribe(fn: (value: T) => void): () => void {
    if (this.closed) return () => {};
    this.subs.add(fn);
    return () => {
      this.subs.delete(fn);
    };
  }

  shutdown(): void {
    this.closed = true;
    this.subs.clear();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get subscriberCount(): number {
    return this.subs.size;
  }
}
