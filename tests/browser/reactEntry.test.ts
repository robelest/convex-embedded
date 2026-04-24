import { describe, expect, it } from "@tests/testkit";
import type { ConvexClient } from "convex/browser";
import { vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAuthStateMock: vi.fn(() => ({ status: "authenticated" as const })),
  subscribeAuthStateMock: vi.fn(
    (
      _client: ConvexClient,
      callback: (state: { status: "authenticated" }) => void,
    ) => {
      callback({ status: "authenticated" });
      return () => {};
    },
  ),
  getAuthIdentityMock: vi.fn(() => ({ subject: "alice" })),
  getRemoteStateMock: vi.fn(() => ({ status: "resolved" as const })),
  subscribeRemoteStateMock: vi.fn(
    (
      _client: ConvexClient,
      callback: (state: { status: "resolved" }) => void,
    ) => {
      callback({ status: "resolved" });
      return () => {};
    },
  ),
}));

vi.mock("@/browser/index", async () => {
  const actual =
    await vi.importActual<typeof import("@/browser/index")>("@/browser/index");

  return {
    ...actual,
    getAuthState: mocks.getAuthStateMock,
    subscribeAuthState: mocks.subscribeAuthStateMock,
    getAuthIdentity: mocks.getAuthIdentityMock,
    getRemoteState: mocks.getRemoteStateMock,
    subscribeRemoteState: mocks.subscribeRemoteStateMock,
  };
});

import {
  getAuthIdentity,
  getAuthState,
  getRemoteState,
  subscribeAuthState,
  subscribeRemoteState,
  wrapConvexBrowserClientForReact,
} from "@resolve/react";

describe("react entry helpers", () => {
  it("unwraps wrapped clients before calling browser helper APIs", () => {
    const browserClient = {
      onUpdate: vi.fn(),
      onPaginatedUpdate_experimental: vi.fn(),
      mutation: vi.fn(),
      action: vi.fn(),
      query: vi.fn(),
      setAuth: vi.fn(),
      clearAuth: vi.fn(),
      connectionState: vi.fn(() => "connected"),
      subscribeToConnectionState: vi.fn(() => () => {}),
      close: vi.fn(async () => {}),
    } as unknown as ConvexClient;
    const client = wrapConvexBrowserClientForReact(browserClient);
    const authCallback = vi.fn();
    const remoteCallback = vi.fn();

    expect(getAuthState(client)).toEqual({ status: "authenticated" });
    expect(getAuthIdentity(client)).toEqual({ subject: "alice" });
    expect(getRemoteState(client)).toEqual({ status: "resolved" });

    subscribeAuthState(client, authCallback);
    subscribeRemoteState(client, remoteCallback);

    expect(mocks.getAuthStateMock).toHaveBeenCalledWith(browserClient);
    expect(mocks.getAuthIdentityMock).toHaveBeenCalledWith(browserClient);
    expect(mocks.getRemoteStateMock).toHaveBeenCalledWith(browserClient);
    expect(mocks.subscribeAuthStateMock).toHaveBeenCalledWith(
      browserClient,
      authCallback,
    );
    expect(mocks.subscribeRemoteStateMock).toHaveBeenCalledWith(
      browserClient,
      remoteCallback,
    );
    expect(authCallback).toHaveBeenCalledWith({ status: "authenticated" });
    expect(remoteCallback).toHaveBeenCalledWith({ status: "resolved" });
  });
});
