import { BrowserSessionBroadcast } from "@embedded/browser/session";
import type { SessionEvent } from "@embedded/runtime/platform";
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

const authChanged: SessionEvent = { type: "authChanged" };

beforeEach(() => {
  MockBroadcastChannel.reset();
  vi.stubGlobal("BroadcastChannel", MockBroadcastChannel);
});

afterEach(() => {
  vi.unstubAllGlobals();
  MockBroadcastChannel.reset();
});

describe("BrowserSessionBroadcast", () => {
  it("does not notify its own callbacks on self notify", ({ track }) => {
    const fanout = track(new BrowserSessionBroadcast());
    const callback = vi.fn();

    fanout.onNotification(callback);
    fanout.notify(authChanged);

    expect(callback).not.toHaveBeenCalled();
  });

  it("notifies another tab on the same channel", ({ track }) => {
    const fanoutA = track(new BrowserSessionBroadcast("shared-session"));
    const fanoutB = track(new BrowserSessionBroadcast("shared-session"));
    const callback = vi.fn();

    fanoutA.onNotification(callback);
    fanoutB.notify(authChanged);

    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith(authChanged);
  });

  it("ignores notifications from a different channel", ({ track }) => {
    const fanoutA = track(new BrowserSessionBroadcast("session-a"));
    const fanoutB = track(new BrowserSessionBroadcast("session-b"));
    const callback = vi.fn();

    fanoutA.onNotification(callback);
    fanoutB.notify(authChanged);

    expect(callback).not.toHaveBeenCalled();
  });

  it("unsubscribe removes only that callback", ({ track }) => {
    const fanoutA = track(new BrowserSessionBroadcast("session-unsub"));
    const fanoutB = track(new BrowserSessionBroadcast("session-unsub"));
    const callbackA = vi.fn();
    const callbackB = vi.fn();

    const unsubscribeA = fanoutA.onNotification(callbackA);
    fanoutA.onNotification(callbackB);

    unsubscribeA();
    fanoutB.notify(authChanged);

    expect(callbackA).not.toHaveBeenCalled();
    expect(callbackB).toHaveBeenCalledOnce();
  });

  it("close() is idempotent and clears callbacks", ({ track }) => {
    const fanoutA = track(new BrowserSessionBroadcast("session-close"));
    const fanoutB = track(new BrowserSessionBroadcast("session-close"));
    const callback = vi.fn();

    fanoutA.onNotification(callback);
    fanoutA.close();
    fanoutA.close();
    fanoutB.notify(authChanged);

    expect(callback).not.toHaveBeenCalled();
  });

  it("uses unique localStorage fallback payloads for repeated notifications", ({
    track,
  }) => {
    vi.stubGlobal(
      "BroadcastChannel",
      undefined as unknown as typeof BroadcastChannel,
    );
    const localStorageMock = { setItem: vi.fn() };
    vi.stubGlobal("localStorage", localStorageMock);
    const fanout = track(
      new BrowserSessionBroadcast("session-storage-fallback"),
    );

    fanout.notify(authChanged);
    fanout.notify(authChanged);

    expect(localStorageMock.setItem).toHaveBeenCalledTimes(2);
    expect(localStorageMock.setItem.mock.calls[0]?.[1]).not.toBe(
      localStorageMock.setItem.mock.calls[1]?.[1],
    );
  });
});
