import { createBrowserWriteBroadcast } from "@embedded/browser/write";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "@tests/testkit";

class MockBroadcastChannel {
  static instances: MockBroadcastChannel[] = [];

  onmessage: ((ev: MessageEvent) => void) | null = null;
  name: string;
  private _closed = false;

  constructor(name: string) {
    this.name = name;
    MockBroadcastChannel.instances.push(this);
  }

  postMessage(data: unknown): void {
    if (this._closed) return;

    for (const instance of MockBroadcastChannel.instances.filter(
      (current) =>
        current !== this && current.name === this.name && !current._closed,
    )) {
      instance.onmessage?.(new MessageEvent("message", { data }));
    }
  }

  close(): void {
    this._closed = true;
  }

  static reset(): void {
    MockBroadcastChannel.instances = [];
  }
}

beforeEach(() => {
  MockBroadcastChannel.reset();
  vi.stubGlobal("BroadcastChannel", MockBroadcastChannel);
});

afterEach(() => {
  vi.unstubAllGlobals();
  MockBroadcastChannel.reset();
});

describe("BrowserWriteBroadcast", () => {
  describe("onNotification", () => {
    it("returns an unsubscribe function", ({ track }) => {
      const fanout = track(createBrowserWriteBroadcast());
      const callback = vi.fn();

      const unsubscribe = fanout.onNotification(callback);

      expect(typeof unsubscribe).toBe("function");
    });
  });

  describe("notify + onNotification (cross-tab)", () => {
    it("does not fire the callback for its own notify", ({ track }) => {
      const fanout = track(createBrowserWriteBroadcast());
      const callback = vi.fn();
      fanout.onNotification(callback);

      fanout.notify(new Set(["users"]));

      expect(callback).not.toHaveBeenCalled();
    });

    it("fires when a different broadcast on the same channel notifies", ({
      track,
    }) => {
      const fanout1 = track(createBrowserWriteBroadcast("test-channel"));
      const fanout2 = track(createBrowserWriteBroadcast("test-channel"));
      const callback = vi.fn<(tablesWritten: Set<string>) => void>();
      fanout1.onNotification(callback);

      fanout2.notify(new Set(["users", "posts"]));

      expect(callback).toHaveBeenCalledOnce();
      const received = callback.mock.calls[0]?.[0];
      expect(received).toEqual(new Set(["users", "posts"]));
    });

    it("does not fire for a different channel name", ({ track }) => {
      const fanout1 = track(createBrowserWriteBroadcast("channel-a"));
      const fanout2 = track(createBrowserWriteBroadcast("channel-b"));
      const callback = vi.fn();
      fanout1.onNotification(callback);

      fanout2.notify(new Set(["users"]));

      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe("unsubscribe", () => {
    it("removes the callback", ({ track }) => {
      const fanout1 = track(createBrowserWriteBroadcast("test-unsub"));
      const fanout2 = track(createBrowserWriteBroadcast("test-unsub"));
      const callback = vi.fn();
      const unsubscribe = fanout1.onNotification(callback);

      unsubscribe();
      fanout2.notify(new Set(["users"]));

      expect(callback).not.toHaveBeenCalled();
    });

    it("does not affect other callbacks", ({ track }) => {
      const fanout1 = track(createBrowserWriteBroadcast("test-multi"));
      const fanout2 = track(createBrowserWriteBroadcast("test-multi"));
      const callback1 = vi.fn();
      const callback2 = vi.fn();
      const unsubscribe1 = fanout1.onNotification(callback1);
      fanout1.onNotification(callback2);

      unsubscribe1();
      fanout2.notify(new Set(["users"]));

      expect(callback1).not.toHaveBeenCalled();
      expect(callback2).toHaveBeenCalledOnce();
    });
  });

  describe("close", () => {
    it("clears callbacks so they no longer fire", ({ track }) => {
      const fanout1 = track(createBrowserWriteBroadcast("test-close"));
      const fanout2 = track(createBrowserWriteBroadcast("test-close"));
      const callback = vi.fn();
      fanout1.onNotification(callback);

      fanout1.close();
      fanout2.notify(new Set(["users"]));

      expect(callback).not.toHaveBeenCalled();
    });

    it("is idempotent", ({ track }) => {
      const fanout = track(createBrowserWriteBroadcast());
      fanout.close();
      expect(() => fanout.close()).not.toThrow();
    });
  });

  describe("notify after close", () => {
    it("is a no-op and does not throw", ({ track }) => {
      const fanout = track(createBrowserWriteBroadcast());
      fanout.close();

      expect(() => fanout.notify(new Set(["users"]))).not.toThrow();
    });

    it("does not post to BroadcastChannel after close", ({ track }) => {
      const fanout1 = track(createBrowserWriteBroadcast("test-closed-notify"));
      const fanout2 = track(createBrowserWriteBroadcast("test-closed-notify"));
      const callback = vi.fn();
      fanout2.onNotification(callback);

      fanout1.close();
      fanout1.notify(new Set(["users"]));

      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe("localStorage fallback", () => {
    it("writes unique payloads for repeated notifications", ({ track }) => {
      vi.stubGlobal(
        "BroadcastChannel",
        undefined as unknown as typeof BroadcastChannel,
      );
      const localStorageMock = { setItem: vi.fn() };
      vi.stubGlobal("localStorage", localStorageMock);
      const fanout = track(createBrowserWriteBroadcast("storage-fallback"));

      fanout.notify(new Set(["users"]));
      fanout.notify(new Set(["users"]));

      expect(localStorageMock.setItem).toHaveBeenCalledTimes(2);
      expect(localStorageMock.setItem.mock.calls[0]?.[1]).not.toBe(
        localStorageMock.setItem.mock.calls[1]?.[1],
      );
    });
  });
});
