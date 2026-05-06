type Cleanup = () => void;
type EffectFn = () => void | Cleanup;

interface Subscriber {
  notify(): void;
  invalidate(): void;
}

let currentSubscriber: Subscriber | null = null;
let batchDepth = 0;
const pendingNotify = new Set<Subscriber>();

function flushPending(): void {
  if (batchDepth !== 0) return;
  if (pendingNotify.size === 0) return;
  const subs = Array.from(pendingNotify);
  pendingNotify.clear();
  for (const sub of subs) {
    try {
      sub.notify();
    } catch {
      /* swallow effect errors */
    }
  }
}

export interface Signal<T> {
  (): T;
  peek(): T;
  set(next: T | ((prev: T) => T)): void;
  subscribe(listener: (value: T) => void): () => void;
}

class WritableSignal<T> implements Subscriber {
  private value: T;
  private readonly subs = new Set<Subscriber>();
  private readonly externalListeners = new Set<(value: T) => void>();
  private notifyingExternal = false;

  constructor(initial: T) {
    this.value = initial;
  }

  read(): T {
    if (currentSubscriber !== null) {
      this.subs.add(currentSubscriber);
    }
    return this.value;
  }

  peek(): T {
    return this.value;
  }

  write(next: T | ((prev: T) => T)): void {
    const resolved =
      typeof next === "function"
        ? (next as (prev: T) => T)(this.value)
        : next;
    if (Object.is(resolved, this.value)) return;
    this.value = resolved;
    for (const sub of this.subs) {
      sub.invalidate();
      pendingNotify.add(sub);
    }
    if (this.externalListeners.size > 0) {
      pendingNotify.add(this);
    }
    flushPending();
  }

  notify(): void {
    if (this.notifyingExternal) return;
    this.notifyingExternal = true;
    try {
      const value = this.value;
      for (const listener of this.externalListeners) {
        try {
          listener(value);
        } catch {
          /* swallow listener errors */
        }
      }
    } finally {
      this.notifyingExternal = false;
    }
  }

  invalidate(): void {
    /* no-op: signals are not invalidated by upstream */
  }

  subscribe(listener: (value: T) => void): () => void {
    this.externalListeners.add(listener);
    try {
      listener(this.value);
    } catch {
      /* swallow */
    }
    return () => {
      this.externalListeners.delete(listener);
    };
  }
}

export function signal<T>(initial: T): Signal<T> {
  const inst = new WritableSignal(initial);
  const callable = (() => inst.read()) as Signal<T>;
  callable.peek = () => inst.peek();
  callable.set = (next) => inst.write(next);
  callable.subscribe = (listener) => inst.subscribe(listener);
  return callable;
}

class Computed<T> implements Subscriber {
  private cached: T | undefined = undefined;
  private hasCache = false;
  private dirty = true;
  private readonly subs = new Set<Subscriber>();
  private readonly externalListeners = new Set<(value: T) => void>();

  constructor(private readonly fn: () => T) {}

  read(): T {
    if (currentSubscriber !== null) {
      this.subs.add(currentSubscriber);
    }
    if (this.dirty || !this.hasCache) {
      const prevSubscriber = currentSubscriber;
      currentSubscriber = this;
      try {
        const next = this.fn();
        if (this.hasCache && Object.is(next, this.cached)) {
          this.dirty = false;
          return this.cached as T;
        }
        this.cached = next;
        this.hasCache = true;
        this.dirty = false;
      } finally {
        currentSubscriber = prevSubscriber;
      }
    }
    return this.cached as T;
  }

  peek(): T {
    if (this.dirty || !this.hasCache) {
      const prevSubscriber = currentSubscriber;
      currentSubscriber = null;
      try {
        this.cached = this.fn();
        this.hasCache = true;
        this.dirty = false;
      } finally {
        currentSubscriber = prevSubscriber;
      }
    }
    return this.cached as T;
  }

  invalidate(): void {
    if (this.dirty) return;
    this.dirty = true;
    for (const sub of this.subs) {
      sub.invalidate();
      pendingNotify.add(sub);
    }
    if (this.externalListeners.size > 0) {
      pendingNotify.add(this);
    }
  }

  notify(): void {
    if (this.externalListeners.size === 0) return;
    const value = this.read();
    for (const listener of this.externalListeners) {
      try {
        listener(value);
      } catch {
        /* swallow */
      }
    }
  }

  subscribe(listener: (value: T) => void): () => void {
    this.externalListeners.add(listener);
    try {
      listener(this.read());
    } catch {
      /* swallow */
    }
    return () => {
      this.externalListeners.delete(listener);
    };
  }
}

export function computed<T>(fn: () => T): Signal<T> {
  const inst = new Computed(fn);
  const callable = (() => inst.read()) as Signal<T>;
  callable.peek = () => inst.peek();
  callable.set = () => {
    throw new Error("[convex-embedded] cannot set a computed signal");
  };
  callable.subscribe = (listener) => inst.subscribe(listener);
  return callable;
}

class EffectScope implements Subscriber {
  private dirty = false;
  private cleanup: Cleanup | undefined;
  private disposed = false;

  constructor(private readonly fn: EffectFn) {
    this.run();
  }

  invalidate(): void {
    if (this.disposed) return;
    this.dirty = true;
  }

  notify(): void {
    if (this.disposed) return;
    if (!this.dirty) return;
    this.run();
  }

  private run(): void {
    if (this.disposed) return;
    if (this.cleanup) {
      try {
        this.cleanup();
      } catch {
        /* swallow */
      }
      this.cleanup = undefined;
    }
    const prevSubscriber = currentSubscriber;
    currentSubscriber = this;
    this.dirty = false;
    try {
      const result = this.fn();
      if (typeof result === "function") {
        this.cleanup = result;
      }
    } catch {
      /* swallow effect errors */
    } finally {
      currentSubscriber = prevSubscriber;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.cleanup) {
      try {
        this.cleanup();
      } catch {
        /* swallow */
      }
      this.cleanup = undefined;
    }
    pendingNotify.delete(this);
  }
}

export function effect(fn: EffectFn): () => void {
  const scope = new EffectScope(fn);
  return () => scope.dispose();
}

export function batch<T>(fn: () => T): T {
  batchDepth += 1;
  try {
    return fn();
  } finally {
    batchDepth -= 1;
    if (batchDepth === 0) flushPending();
  }
}

export function untracked<T>(fn: () => T): T {
  const prevSubscriber = currentSubscriber;
  currentSubscriber = null;
  try {
    return fn();
  } finally {
    currentSubscriber = prevSubscriber;
  }
}
