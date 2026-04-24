import {
  LoopbackWebSocket,
  LoopbackWebSocketConstructor,
  type LoopbackMessageEvent,
} from "@embedded/runtime/loopback";
import { createTransport } from "@embedded/runtime/transport";
import { afterEach, describe, it, expect } from "@tests/testkit";
import { vi } from "vitest";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Flush the microtask queue so the WebSocket transitions to OPEN. */
const flushMicrotasks = () => new Promise<void>((r) => queueMicrotask(r));

async function settleMicrotasks(count = 4): Promise<void> {
  for (let i = 0; i < count; i++) {
    await flushMicrotasks();
  }
}

/** Default echo handler for most tests. */
function echoHandler() {
  return vi.fn(async (message: string) => {
    const parsed = JSON.parse(message);
    return [JSON.stringify({ echo: parsed })];
  });
}

// ---------------------------------------------------------------------------
// LoopbackWebSocket
// ---------------------------------------------------------------------------

describe("LoopbackWebSocket", () => {
  // -----------------------------------------------------------------------
  // Initial state
  // -----------------------------------------------------------------------

  describe("initial state", () => {
    it("readyState is CONNECTING (0) immediately after construction", () => {
      const ws = new LoopbackWebSocket("ws://localhost", echoHandler());
      expect(ws.readyState).toBe(0);
      expect(ws.readyState).toBe(ws.CONNECTING);
    });

    it("has the correct url", () => {
      const ws = new LoopbackWebSocket(
        "ws://localhost:8080/sync",
        echoHandler(),
      );
      expect(ws.url).toBe("ws://localhost:8080/sync");
    });
  });

  // -----------------------------------------------------------------------
  // Open transition
  // -----------------------------------------------------------------------

  describe("open transition", () => {
    it("readyState becomes OPEN (1) on next microtask", async () => {
      const ws = new LoopbackWebSocket("ws://localhost", echoHandler());
      expect(ws.readyState).toBe(0);

      await flushMicrotasks();

      expect(ws.readyState).toBe(1);
      expect(ws.readyState).toBe(ws.OPEN);
    });

    it("fires onopen callback", async () => {
      const ws = new LoopbackWebSocket("ws://localhost", echoHandler());
      const onopen = vi.fn();
      ws.onopen = onopen;

      await flushMicrotasks();

      expect(onopen).toHaveBeenCalledOnce();
      expect(onopen).toHaveBeenCalledWith(
        expect.objectContaining({ type: "open" }),
      );
    });

    it("fires 'open' event listeners", async () => {
      const ws = new LoopbackWebSocket("ws://localhost", echoHandler());
      const listener = vi.fn();
      ws.addEventListener("open", listener);

      await flushMicrotasks();

      expect(listener).toHaveBeenCalledOnce();
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ type: "open" }),
      );
    });

    it("does not open if close() was called before microtask fires", async () => {
      const ws = new LoopbackWebSocket("ws://localhost", echoHandler());
      const onopen = vi.fn();
      ws.onopen = onopen;

      ws.close();
      await flushMicrotasks();

      expect(onopen).not.toHaveBeenCalled();
      expect(ws.readyState).toBe(3);
    });
  });

  // -----------------------------------------------------------------------
  // Send / receive
  // -----------------------------------------------------------------------

  describe("send / receive", () => {
    it("send() calls handler and delivers response via onmessage", async () => {
      const handler = echoHandler();
      const ws = new LoopbackWebSocket("ws://localhost", handler);
      await flushMicrotasks();

      const onmessage = vi.fn();
      ws.onmessage = onmessage;

      ws.send(JSON.stringify({ hello: "world" }));

      // Handler is async so delivery is scheduled on microtask queue
      await flushMicrotasks();

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(JSON.stringify({ hello: "world" }));

      expect(onmessage).toHaveBeenCalledOnce();
      const event = onmessage.mock.calls[0][0];
      expect(event.type).toBe("message");
      expect(JSON.parse(event.data)).toEqual({ echo: { hello: "world" } });
    });
  });

  // -----------------------------------------------------------------------
  // Multiple responses
  // -----------------------------------------------------------------------

  describe("multiple responses", () => {
    it("handler returning multiple strings fires onmessage for each", async () => {
      const handler = vi.fn(async () => [
        JSON.stringify({ seq: 1 }),
        JSON.stringify({ seq: 2 }),
        JSON.stringify({ seq: 3 }),
      ]);
      const ws = new LoopbackWebSocket("ws://localhost", handler);
      await flushMicrotasks();

      const onmessage = vi.fn();
      ws.onmessage = onmessage;

      ws.send("anything");
      await settleMicrotasks();

      expect(onmessage).toHaveBeenCalledTimes(3);
      expect(JSON.parse(onmessage.mock.calls[0][0].data)).toEqual({ seq: 1 });
      expect(JSON.parse(onmessage.mock.calls[1][0].data)).toEqual({ seq: 2 });
      expect(JSON.parse(onmessage.mock.calls[2][0].data)).toEqual({ seq: 3 });
    });
  });

  describe("message ordering", () => {
    it("delivers responses in send order even when handlers resolve out of order", async () => {
      let first = true;
      const handler = vi.fn(async (message: string) => {
        const parsed = JSON.parse(message) as { seq: number };
        if (first) {
          first = false;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        return [JSON.stringify({ seq: parsed.seq })];
      });

      const ws = new LoopbackWebSocket("ws://localhost", handler);
      await flushMicrotasks();

      const seen: number[] = [];
      ws.onmessage = (event) => {
        seen.push(JSON.parse(event.data).seq);
      };

      ws.send(JSON.stringify({ seq: 1 }));
      ws.send(JSON.stringify({ seq: 2 }));

      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(seen).toEqual([1, 2]);
    });

    it("serializes pushed messages behind in-flight send responses", async () => {
      let release!: () => void;
      const handler = vi.fn(
        () =>
          new Promise<string[]>((resolve) => {
            release = () =>
              resolve([JSON.stringify({ type: "Response", seq: 1 })]);
          }),
      );

      const ws = new LoopbackWebSocket("ws://localhost", handler);
      await flushMicrotasks();

      const seen: Array<{ type: string; seq: number }> = [];
      ws.onmessage = (event) => {
        const parsed = JSON.parse(event.data) as { type: string; seq: number };
        seen.push(parsed);
      };

      ws.send(JSON.stringify({ seq: 1 }));
      ws.deliverMessage(JSON.stringify({ type: "Push", seq: 2 }));

      await Promise.resolve();
      expect(seen).toEqual([]);

      release();
      await settleMicrotasks();

      expect(seen).toEqual([
        { type: "Response", seq: 1 },
        { type: "Push", seq: 2 },
      ]);
    });
  });

  // -----------------------------------------------------------------------
  // Send before open
  // -----------------------------------------------------------------------

  describe("send before open", () => {
    it("throws 'WebSocket is not open'", () => {
      const ws = new LoopbackWebSocket("ws://localhost", echoHandler());
      expect(ws.readyState).toBe(0);

      expect(() => ws.send("test")).toThrow("WebSocket is not open");
    });
  });

  // -----------------------------------------------------------------------
  // Close
  // -----------------------------------------------------------------------

  describe("close", () => {
    it("readyState becomes CLOSED (3)", async () => {
      const ws = new LoopbackWebSocket("ws://localhost", echoHandler());
      await flushMicrotasks();

      ws.close();
      expect(ws.readyState).toBe(3);
      expect(ws.readyState).toBe(ws.CLOSED);
    });

    it("fires onclose callback", async () => {
      const ws = new LoopbackWebSocket("ws://localhost", echoHandler());
      await flushMicrotasks();

      const onclose = vi.fn();
      ws.onclose = onclose;

      ws.close();

      expect(onclose).toHaveBeenCalledOnce();
      expect(onclose).toHaveBeenCalledWith(
        expect.objectContaining({ type: "close", code: 1000, reason: "" }),
      );
    });

    it("passes custom code and reason to onclose event", async () => {
      const ws = new LoopbackWebSocket("ws://localhost", echoHandler());
      await flushMicrotasks();

      const onclose = vi.fn();
      ws.onclose = onclose;

      ws.close(4001, "custom reason");

      expect(onclose).toHaveBeenCalledWith(
        expect.objectContaining({ code: 4001, reason: "custom reason" }),
      );
    });

    it("close() is idempotent on an already-closed socket", async () => {
      const ws = new LoopbackWebSocket("ws://localhost", echoHandler());
      await flushMicrotasks();

      const onclose = vi.fn();
      ws.onclose = onclose;

      ws.close();
      ws.close(); // second call should be a no-op

      expect(onclose).toHaveBeenCalledOnce();
    });
  });

  // -----------------------------------------------------------------------
  // Send after close
  // -----------------------------------------------------------------------

  describe("send after close", () => {
    it("throws because readyState is not OPEN", async () => {
      const ws = new LoopbackWebSocket("ws://localhost", echoHandler());
      await flushMicrotasks();

      ws.close();

      expect(() => ws.send("test")).toThrow("WebSocket is not open");
    });

    it("responses are not delivered if socket closes during handler execution", async () => {
      // Handler that returns after a delay
      const handler = vi.fn(async () => {
        return [JSON.stringify({ late: true })];
      });
      const ws = new LoopbackWebSocket("ws://localhost", handler);
      await flushMicrotasks();

      const onmessage = vi.fn();
      ws.onmessage = onmessage;

      ws.send("test");
      // Close before the microtask delivers the response
      ws.close();

      await flushMicrotasks();

      // onmessage should not fire because readyState is CLOSED
      expect(onmessage).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // addEventListener
  // -----------------------------------------------------------------------

  describe("addEventListener", () => {
    it("'message' listeners fire alongside onmessage", async () => {
      const ws = new LoopbackWebSocket("ws://localhost", echoHandler());
      await flushMicrotasks();

      const onmessage = vi.fn();
      const listener = vi.fn();
      ws.onmessage = onmessage;
      ws.addEventListener("message", listener);

      ws.send(JSON.stringify({ x: 1 }));
      await flushMicrotasks();

      expect(onmessage).toHaveBeenCalledOnce();
      expect(listener).toHaveBeenCalledOnce();

      // Both receive the same event
      expect(listener.mock.calls[0][0].data).toBe(
        onmessage.mock.calls[0][0].data,
      );
    });

    it("multiple listeners of the same type all fire", async () => {
      const ws = new LoopbackWebSocket("ws://localhost", echoHandler());
      await flushMicrotasks();

      const listener1 = vi.fn();
      const listener2 = vi.fn();
      ws.addEventListener("message", listener1);
      ws.addEventListener("message", listener2);

      ws.send(JSON.stringify({ x: 1 }));
      await flushMicrotasks();

      expect(listener1).toHaveBeenCalledOnce();
      expect(listener2).toHaveBeenCalledOnce();
    });

    it("'close' listeners fire on close", async () => {
      const ws = new LoopbackWebSocket("ws://localhost", echoHandler());
      await flushMicrotasks();

      const listener = vi.fn();
      ws.addEventListener("close", listener);

      ws.close();

      expect(listener).toHaveBeenCalledOnce();
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ type: "close" }),
      );
    });
  });

  // -----------------------------------------------------------------------
  // removeEventListener
  // -----------------------------------------------------------------------

  describe("removeEventListener", () => {
    it("removed listeners don't fire", async () => {
      const ws = new LoopbackWebSocket("ws://localhost", echoHandler());
      await flushMicrotasks();

      const listener = vi.fn();
      ws.addEventListener("message", listener);
      ws.removeEventListener("message", listener);

      ws.send(JSON.stringify({ x: 1 }));
      await flushMicrotasks();

      expect(listener).not.toHaveBeenCalled();
    });

    it("removing a non-existent listener is a no-op", () => {
      const ws = new LoopbackWebSocket("ws://localhost", echoHandler());
      const listener = vi.fn();

      // Should not throw
      expect(() => ws.removeEventListener("message", listener)).not.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // Error handling
  // -----------------------------------------------------------------------

  describe("error handling", () => {
    it("handler rejection fires onerror", async () => {
      const error = new Error("handler exploded");
      const handler = vi.fn(async () => {
        throw error;
      });
      const ws = new LoopbackWebSocket("ws://localhost", handler);
      await flushMicrotasks();

      const onerror = vi.fn();
      ws.onerror = onerror;

      ws.send("test");
      await settleMicrotasks();

      expect(onerror).toHaveBeenCalledOnce();
      expect(onerror).toHaveBeenCalledWith(
        expect.objectContaining({ type: "error", error }),
      );
    });

    it("handler rejection also fires 'error' event listeners", async () => {
      const handler = vi.fn(async () => {
        throw new Error("boom");
      });
      const ws = new LoopbackWebSocket("ws://localhost", handler);
      await flushMicrotasks();

      const listener = vi.fn();
      ws.addEventListener("error", listener);

      ws.send("test");
      await settleMicrotasks();

      expect(listener).toHaveBeenCalledOnce();
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ type: "error" }),
      );
    });
  });

  // -----------------------------------------------------------------------
  // Static constants
  // -----------------------------------------------------------------------

  describe("static constants", () => {
    it("CONNECTING is 0", () => {
      expect(LoopbackWebSocket.CONNECTING).toBe(0);
    });

    it("OPEN is 1", () => {
      expect(LoopbackWebSocket.OPEN).toBe(1);
    });

    it("CLOSING is 2", () => {
      expect(LoopbackWebSocket.CLOSING).toBe(2);
    });

    it("CLOSED is 3", () => {
      expect(LoopbackWebSocket.CLOSED).toBe(3);
    });

    it("instance constants match static constants", () => {
      const ws = new LoopbackWebSocket("ws://localhost", echoHandler());
      expect(ws.CONNECTING).toBe(LoopbackWebSocket.CONNECTING);
      expect(ws.OPEN).toBe(LoopbackWebSocket.OPEN);
      expect(ws.CLOSING).toBe(LoopbackWebSocket.CLOSING);
      expect(ws.CLOSED).toBe(LoopbackWebSocket.CLOSED);
    });
  });
});

// ---------------------------------------------------------------------------
// LoopbackWebSocketConstructor
// ---------------------------------------------------------------------------

describe("LoopbackWebSocketConstructor", () => {
  it("creates instances with the handler bound", async () => {
    const handler = echoHandler();
    const WsClass = LoopbackWebSocketConstructor(handler);

    const ws = new WsClass("ws://localhost/sync");
    expect(ws).toBeInstanceOf(LoopbackWebSocket);
    expect(ws.url).toBe("ws://localhost/sync");

    await flushMicrotasks();
    expect(ws.readyState).toBe(1);

    const onmessage = vi.fn();
    ws.onmessage = onmessage;

    ws.send(JSON.stringify({ test: true }));
    await flushMicrotasks();

    expect(handler).toHaveBeenCalledOnce();
    expect(onmessage).toHaveBeenCalledOnce();
  });

  it("each new instance shares the same handler", async () => {
    const handler = echoHandler();
    const WsClass = LoopbackWebSocketConstructor(handler);

    const ws1 = new WsClass("ws://localhost/a");
    const ws2 = new WsClass("ws://localhost/b");

    await flushMicrotasks();

    ws1.send(JSON.stringify({ from: 1 }));
    ws2.send(JSON.stringify({ from: 2 }));

    await flushMicrotasks();

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("constructor only takes url as an argument", () => {
    const WsClass = LoopbackWebSocketConstructor(echoHandler());
    // Should work with just a url — no second arg needed
    const ws = new WsClass("ws://localhost");
    expect(ws.url).toBe("ws://localhost");
  });
});

// ---------------------------------------------------------------------------
// createTransport — closeAll
// ---------------------------------------------------------------------------

describe("createTransport", () => {
  /** Minimal protocol handler that echoes messages. */
  function stubRuntime() {
    return {
      handleMessage: vi.fn(async (message: string) => {
        return [JSON.stringify({ echo: JSON.parse(message) })];
      }),
      teardownSession: vi.fn(),
    };
  }

  it("injects captured sessionId into later messages on the same socket", async () => {
    const runtime = stubRuntime();
    const transport = createTransport(runtime);

    const ws = new transport.webSocketConstructor("ws://a");
    await flushMicrotasks();

    ws.send(
      JSON.stringify({
        type: "Connect",
        sessionId: "session-a",
        connectionCount: 0,
        lastCloseReason: null,
        clientTs: Date.now(),
      }),
    );
    await settleMicrotasks();

    ws.send(
      JSON.stringify({
        type: "ModifyQuerySet",
        baseVersion: 0,
        newVersion: 1,
        modifications: [],
      }),
    );
    await settleMicrotasks();

    expect(runtime.handleMessage).toHaveBeenLastCalledWith(
      JSON.stringify({
        type: "ModifyQuerySet",
        baseVersion: 0,
        newVersion: 1,
        modifications: [],
        sessionId: "session-a",
      }),
    );
  });

  it("targets pushed messages to sockets in the matching session only", async () => {
    const runtime = stubRuntime();
    const transport = createTransport(runtime);

    const ws1 = new transport.webSocketConstructor("ws://a");
    const ws2 = new transport.webSocketConstructor("ws://b");
    await flushMicrotasks();

    const seen1: string[] = [];
    const seen2: string[] = [];
    ws1.onmessage = (event: LoopbackMessageEvent) => seen1.push(event.data);
    ws2.onmessage = (event: LoopbackMessageEvent) => seen2.push(event.data);

    ws1.send(
      JSON.stringify({
        type: "Connect",
        sessionId: "session-a",
        connectionCount: 0,
        lastCloseReason: null,
        clientTs: Date.now(),
      }),
    );
    ws2.send(
      JSON.stringify({
        type: "Connect",
        sessionId: "session-b",
        connectionCount: 0,
        lastCloseReason: null,
        clientTs: Date.now(),
      }),
    );
    await settleMicrotasks();

    seen1.length = 0;
    seen2.length = 0;

    transport.pushMessage(
      "session-a",
      JSON.stringify({ type: "Transition", target: "a" }),
    );
    await settleMicrotasks();

    expect(seen1).toEqual([
      JSON.stringify({ type: "Transition", target: "a" }),
    ]);
    expect(seen2).toEqual([]);
  });

  it("tears down a session when its last socket closes", async () => {
    const runtime = stubRuntime();
    const transport = createTransport(runtime);

    const ws1 = new transport.webSocketConstructor("ws://a");
    const ws2 = new transport.webSocketConstructor("ws://b");
    await flushMicrotasks();

    ws1.send(
      JSON.stringify({
        type: "Connect",
        sessionId: "session-a",
        connectionCount: 0,
        lastCloseReason: null,
        clientTs: Date.now(),
      }),
    );
    ws2.send(
      JSON.stringify({
        type: "Connect",
        sessionId: "session-a",
        connectionCount: 1,
        lastCloseReason: null,
        clientTs: Date.now(),
      }),
    );
    await settleMicrotasks();

    ws1.close();
    expect(runtime.teardownSession).not.toHaveBeenCalled();

    ws2.close();
    expect(runtime.teardownSession).toHaveBeenCalledWith("session-a");
    expect(runtime.teardownSession).toHaveBeenCalledTimes(1);
  });

  describe("closeAll", () => {
    afterEach(() => vi.useRealTimers());

    it("closes all active WebSocket connections", async () => {
      const transport = createTransport(stubRuntime());

      const ws1 = new transport.webSocketConstructor("ws://a");
      const ws2 = new transport.webSocketConstructor("ws://b");
      await flushMicrotasks();

      expect(ws1.readyState).toBe(LoopbackWebSocket.OPEN);
      expect(ws2.readyState).toBe(LoopbackWebSocket.OPEN);

      transport.closeAll();

      expect(ws1.readyState).toBe(LoopbackWebSocket.CLOSED);
      expect(ws2.readyState).toBe(LoopbackWebSocket.CLOSED);
    });

    it("fires onclose events with code 1001", async () => {
      const transport = createTransport(stubRuntime());

      const ws = new transport.webSocketConstructor("ws://a");
      await flushMicrotasks();

      const onclose = vi.fn();
      ws.onclose = onclose;

      transport.closeAll();

      expect(onclose).toHaveBeenCalledOnce();
      expect(onclose).toHaveBeenCalledWith(
        expect.objectContaining({ code: 1001, reason: "runtime shutdown" }),
      );
    });

    it("clears ping intervals so they don't leak", async () => {
      vi.useFakeTimers();
      const transport = createTransport(stubRuntime());

      const ws = new transport.webSocketConstructor("ws://a");
      await flushMicrotasks();

      const onmessage = vi.fn();
      ws.onmessage = onmessage;

      // closeAll should clear the interval
      transport.closeAll();
      expect(ws.readyState).toBe(LoopbackWebSocket.CLOSED);

      // Advance time past the ping interval — no ping should fire.
      vi.advanceTimersByTime(60_000);

      // onmessage should not have been called (no Ping after close).
      expect(onmessage).not.toHaveBeenCalled();
    });

    it("is idempotent", async () => {
      const transport = createTransport(stubRuntime());

      const ws = new transport.webSocketConstructor("ws://a");
      await flushMicrotasks();

      transport.closeAll();
      // Second call should not throw
      transport.closeAll();

      expect(ws.readyState).toBe(LoopbackWebSocket.CLOSED);
    });

    it("does not affect sockets that were already closed", async () => {
      const transport = createTransport(stubRuntime());

      const ws1 = new transport.webSocketConstructor("ws://a");
      const ws2 = new transport.webSocketConstructor("ws://b");
      await flushMicrotasks();

      // Manually close ws1 before calling closeAll
      ws1.close();
      expect(ws1.readyState).toBe(LoopbackWebSocket.CLOSED);

      const onclose2 = vi.fn();
      ws2.onclose = onclose2;

      transport.closeAll();

      // ws2 should have been closed
      expect(ws2.readyState).toBe(LoopbackWebSocket.CLOSED);
      expect(onclose2).toHaveBeenCalledOnce();
    });

    it("does not track sockets created after closeAll", async () => {
      const transport = createTransport(stubRuntime());

      const ws1 = new transport.webSocketConstructor("ws://a");
      await flushMicrotasks();

      transport.closeAll();
      expect(ws1.readyState).toBe(LoopbackWebSocket.CLOSED);

      // New socket after closeAll should work independently
      const ws2 = new transport.webSocketConstructor("ws://b");
      await flushMicrotasks();
      expect(ws2.readyState).toBe(LoopbackWebSocket.OPEN);

      // Clean up
      ws2.close();
    });
  });
});
