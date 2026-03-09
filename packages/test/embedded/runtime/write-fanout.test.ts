import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WriteFanout } from "#embedded/runtime/write-fanout.js";

// ---------------------------------------------------------------------------
// Mock BroadcastChannel
// ---------------------------------------------------------------------------

class MockBroadcastChannel {
  static instances: MockBroadcastChannel[] = [];

  onmessage: ((ev: MessageEvent) => void) | null = null;
  name: string;
  private _closed = false;

  constructor(name: string) {
    this.name = name;
    MockBroadcastChannel.instances.push(this);
  }

  postMessage(data: any): void {
    if (this._closed) return;
    // BroadcastChannel delivers to OTHER instances with the same name
    for (const inst of MockBroadcastChannel.instances) {
      if (inst !== this && inst.name === this.name && !inst._closed && inst.onmessage) {
        inst.onmessage(new MessageEvent("message", { data }));
      }
    }
  }

  close(): void {
    this._closed = true;
  }

  static reset(): void {
    MockBroadcastChannel.instances = [];
  }
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  MockBroadcastChannel.reset();
  vi.stubGlobal("BroadcastChannel", MockBroadcastChannel);
});

afterEach(() => {
  vi.unstubAllGlobals();
  MockBroadcastChannel.reset();
});

// ---------------------------------------------------------------------------
// WriteFanout
// ---------------------------------------------------------------------------

describe("WriteFanout", () => {
  // -----------------------------------------------------------------------
  // onNotification
  // -----------------------------------------------------------------------

  describe("onNotification", () => {
    it("registers a callback", () => {
      const fanout = new WriteFanout();
      const cb = vi.fn();

      // Should not throw
      const unsub = fanout.onNotification(cb);
      expect(typeof unsub).toBe("function");

      fanout.close();
    });
  });

  // -----------------------------------------------------------------------
  // notify + onNotification (cross-tab behaviour)
  // -----------------------------------------------------------------------

  describe("notify + onNotification (cross-tab)", () => {
    it("callback does NOT fire for own notify (BroadcastChannel only fires in other tabs)", () => {
      const fanout = new WriteFanout();
      const cb = vi.fn();
      fanout.onNotification(cb);

      // notify() posts to BroadcastChannel, but BroadcastChannel does not
      // fire onmessage on the same instance — only on other instances
      fanout.notify(new Set(["users"]));

      expect(cb).not.toHaveBeenCalled();

      fanout.close();
    });

    it("callback fires when a DIFFERENT WriteFanout on the same channel notifies", () => {
      const fanout1 = new WriteFanout("test-channel");
      const fanout2 = new WriteFanout("test-channel");

      const cb1 = vi.fn();
      fanout1.onNotification(cb1);

      // fanout2 writes → fanout1 should be notified
      fanout2.notify(new Set(["users", "posts"]));

      expect(cb1).toHaveBeenCalledOnce();
      const received = cb1.mock.calls[0][0] as Set<string>;
      expect(received).toBeInstanceOf(Set);
      expect(received.has("users")).toBe(true);
      expect(received.has("posts")).toBe(true);

      fanout1.close();
      fanout2.close();
    });

    it("callback does NOT fire for a different channel name", () => {
      const fanout1 = new WriteFanout("channel-a");
      const fanout2 = new WriteFanout("channel-b");

      const cb = vi.fn();
      fanout1.onNotification(cb);

      fanout2.notify(new Set(["users"]));

      expect(cb).not.toHaveBeenCalled();

      fanout1.close();
      fanout2.close();
    });
  });

  // -----------------------------------------------------------------------
  // Unsubscribe
  // -----------------------------------------------------------------------

  describe("unsubscribe", () => {
    it("returned function removes the callback", () => {
      const fanout1 = new WriteFanout("test-unsub");
      const fanout2 = new WriteFanout("test-unsub");

      const cb = vi.fn();
      const unsub = fanout1.onNotification(cb);

      // Remove callback
      unsub();

      // Notify from the other fanout
      fanout2.notify(new Set(["users"]));

      expect(cb).not.toHaveBeenCalled();

      fanout1.close();
      fanout2.close();
    });

    it("unsubscribing one callback does not affect others", () => {
      const fanout1 = new WriteFanout("test-multi");
      const fanout2 = new WriteFanout("test-multi");

      const cb1 = vi.fn();
      const cb2 = vi.fn();

      const unsub1 = fanout1.onNotification(cb1);
      fanout1.onNotification(cb2);

      unsub1();

      fanout2.notify(new Set(["users"]));

      expect(cb1).not.toHaveBeenCalled();
      expect(cb2).toHaveBeenCalledOnce();

      fanout1.close();
      fanout2.close();
    });
  });

  // -----------------------------------------------------------------------
  // Close
  // -----------------------------------------------------------------------

  describe("close", () => {
    it("clears callbacks so they no longer fire", () => {
      const fanout1 = new WriteFanout("test-close");
      const fanout2 = new WriteFanout("test-close");

      const cb = vi.fn();
      fanout1.onNotification(cb);

      fanout1.close();

      // Even if the underlying BroadcastChannel somehow delivers, the
      // callbacks set has been cleared
      fanout2.notify(new Set(["users"]));

      expect(cb).not.toHaveBeenCalled();

      fanout2.close();
    });

    it("is idempotent — calling close() twice does not throw", () => {
      const fanout = new WriteFanout();
      fanout.close();
      expect(() => fanout.close()).not.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // Notify after close
  // -----------------------------------------------------------------------

  describe("notify after close", () => {
    it("is a no-op and does not throw", () => {
      const fanout = new WriteFanout();
      fanout.close();

      expect(() => fanout.notify(new Set(["users"]))).not.toThrow();
    });

    it("does not post to BroadcastChannel after close", () => {
      const fanout1 = new WriteFanout("test-closed-notify");
      const fanout2 = new WriteFanout("test-closed-notify");

      const cb = vi.fn();
      fanout2.onNotification(cb);

      fanout1.close();
      fanout1.notify(new Set(["users"]));

      expect(cb).not.toHaveBeenCalled();

      fanout2.close();
    });
  });
});
