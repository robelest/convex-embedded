import { BrowserSessionBroadcast } from "@embedded/browser/session";
import { afterEach, beforeEach, describe, expect, it } from "@tests/testkit";
import { vi } from "vitest";

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
      instance.onmessage?.({ data } as MessageEvent);
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

describe("BrowserSessionBroadcast", () => {
  it("does not notify its own callbacks on self notify", () => {
    const fanout = new BrowserSessionBroadcast();
    const callback = vi.fn();

    fanout.onNotification(callback);
    fanout.notify({ type: "authChanged" });

    expect(callback).not.toHaveBeenCalled();

    fanout.close();
  });

  it("notifies another tab on the same channel", () => {
    const fanoutA = new BrowserSessionBroadcast("shared-session");
    const fanoutB = new BrowserSessionBroadcast("shared-session");
    const callback = vi.fn();

    fanoutA.onNotification(callback);
    fanoutB.notify({ type: "authChanged" });

    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith({ type: "authChanged" });

    fanoutA.close();
    fanoutB.close();
  });

  it("ignores notifications from a different channel", () => {
    const fanoutA = new BrowserSessionBroadcast("session-a");
    const fanoutB = new BrowserSessionBroadcast("session-b");
    const callback = vi.fn();

    fanoutA.onNotification(callback);
    fanoutB.notify({ type: "authChanged" });

    expect(callback).not.toHaveBeenCalled();

    fanoutA.close();
    fanoutB.close();
  });

  it("unsubscribe removes only that callback", () => {
    const fanoutA = new BrowserSessionBroadcast("session-unsub");
    const fanoutB = new BrowserSessionBroadcast("session-unsub");
    const callbackA = vi.fn();
    const callbackB = vi.fn();

    const unsubscribeA = fanoutA.onNotification(callbackA);
    fanoutA.onNotification(callbackB);

    unsubscribeA();
    fanoutB.notify({ type: "authChanged" });

    expect(callbackA).not.toHaveBeenCalled();
    expect(callbackB).toHaveBeenCalledOnce();

    fanoutA.close();
    fanoutB.close();
  });

  it("close() is idempotent and clears callbacks", () => {
    const fanoutA = new BrowserSessionBroadcast("session-close");
    const fanoutB = new BrowserSessionBroadcast("session-close");
    const callback = vi.fn();

    fanoutA.onNotification(callback);
    fanoutA.close();
    fanoutA.close();
    fanoutB.notify({ type: "authChanged" });

    expect(callback).not.toHaveBeenCalled();

    fanoutB.close();
  });

  it("uses unique localStorage fallback payloads for repeated notifications", () => {
    vi.stubGlobal(
      "BroadcastChannel",
      undefined as unknown as typeof BroadcastChannel,
    );
    const localStorageMock = { setItem: vi.fn() };
    vi.stubGlobal("localStorage", localStorageMock);
    const fanout = new BrowserSessionBroadcast("session-storage-fallback");

    fanout.notify({ type: "authChanged" });
    fanout.notify({ type: "authChanged" });

    expect(localStorageMock.setItem).toHaveBeenCalledTimes(2);
    expect(localStorageMock.setItem.mock.calls[0]?.[1]).not.toBe(
      localStorageMock.setItem.mock.calls[1]?.[1],
    );

    fanout.close();
  });
});
