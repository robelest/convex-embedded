import { describe, it, expect, vi } from "vitest";
import {
  LoopbackWebSocket,
  LoopbackWebSocketConstructor,
} from "#embedded/runtime/loopback-ws.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Flush the microtask queue so the WebSocket transitions to OPEN. */
const flushMicrotasks = () => new Promise<void>((r) => queueMicrotask(r));

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
      const ws = new LoopbackWebSocket("ws://localhost:8080/sync", echoHandler());
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
      expect(onopen).toHaveBeenCalledWith(expect.objectContaining({ type: "open" }));
    });

    it("fires 'open' event listeners", async () => {
      const ws = new LoopbackWebSocket("ws://localhost", echoHandler());
      const listener = vi.fn();
      ws.addEventListener("open", listener);

      await flushMicrotasks();

      expect(listener).toHaveBeenCalledOnce();
      expect(listener).toHaveBeenCalledWith(expect.objectContaining({ type: "open" }));
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
      await flushMicrotasks();

      expect(onmessage).toHaveBeenCalledTimes(3);
      expect(JSON.parse(onmessage.mock.calls[0][0].data)).toEqual({ seq: 1 });
      expect(JSON.parse(onmessage.mock.calls[1][0].data)).toEqual({ seq: 2 });
      expect(JSON.parse(onmessage.mock.calls[2][0].data)).toEqual({ seq: 3 });
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
      expect(listener.mock.calls[0][0].data).toBe(onmessage.mock.calls[0][0].data);
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
      await flushMicrotasks();

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
      await flushMicrotasks();

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
