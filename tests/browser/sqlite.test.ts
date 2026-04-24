import { openBrowserSqlClient } from "@embedded/browser/sqlite/client";
import { afterEach, beforeEach, describe, expect, it } from "@tests/testkit";
import { vi } from "vitest";

type MessageHandler = (event: MessageEvent<any>) => void;
type ErrorHandler = (event: ErrorEvent) => void;

class MockWorker {
  static instances: MockWorker[] = [];

  readonly messageHandlers = new Set<MessageHandler>();
  readonly errorHandlers = new Set<ErrorHandler>();
  readonly postMessage = vi.fn(
    (message: unknown, transfer?: Array<Transferable>) => {
      this.messages.push({ message, transfer: transfer ?? [] });
    },
  );
  readonly messages: Array<{
    message: any;
    transfer: Array<Transferable>;
  }> = [];
  terminated = false;

  constructor(
    readonly url: URL,
    readonly options: WorkerOptions,
  ) {
    MockWorker.instances.push(this);
  }

  addEventListener(
    type: "message" | "error",
    handler: MessageHandler | ErrorHandler,
  ) {
    if (type === "message") {
      this.messageHandlers.add(handler as MessageHandler);
      return;
    }
    this.errorHandlers.add(handler as ErrorHandler);
  }

  terminate() {
    this.terminated = true;
  }

  reply(response: unknown) {
    for (const handler of this.messageHandlers) {
      handler({ data: response } as MessageEvent<any>);
    }
  }

  fail(error: Error) {
    for (const handler of this.errorHandlers) {
      handler({ error, message: error.message } as ErrorEvent);
    }
  }

  static reset() {
    MockWorker.instances = [];
  }
}

describe("openBrowserSqlClient", () => {
  beforeEach(() => {
    MockWorker.reset();
    vi.stubGlobal("Worker", MockWorker as unknown as typeof Worker);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    MockWorker.reset();
  });

  it("terminates the worker when init fails", async () => {
    const opening = openBrowserSqlClient({ name: "sqlite-init-fail" });
    const worker = MockWorker.instances[0]!;
    const initMessage = worker.messages[0]?.message;

    expect(initMessage).toMatchObject({
      method: "init",
      payload: { name: "sqlite-init-fail" },
    });

    worker.reply({
      id: initMessage.id,
      ok: false,
      error: "init failed",
    });

    await expect(opening).rejects.toThrow("init failed");
    expect(worker.terminated).toBe(true);
  });

  it("rejects in-flight requests when the worker errors", async () => {
    const opening = openBrowserSqlClient({ name: "sqlite-worker-error" });
    const worker = MockWorker.instances[0]!;
    const initMessage = worker.messages[0]!.message;

    worker.reply({ id: initMessage.id, ok: true, result: null });
    const client = await opening;

    const getMetaPromise = client.getMeta();
    const requestMessage = worker.messages[1]!.message;
    expect(requestMessage.method).toBe("getMeta");

    worker.fail(new Error("worker crashed"));

    await expect(getMetaPromise).rejects.toThrow("worker crashed");
  });

  it("times out requests that never receive a response", async () => {
    vi.useFakeTimers();

    const opening = openBrowserSqlClient({ name: "sqlite-timeout" });
    const worker = MockWorker.instances[0]!;
    const initMessage = worker.messages[0]!.message;
    worker.reply({ id: initMessage.id, ok: true, result: null });
    const client = await opening;

    const pending = client.getMeta();
    const rejection = pending.catch((error) => error);
    await vi.advanceTimersByTimeAsync(15_000);

    const error = await rejection;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(
      /timed out after 15000ms.*getMeta/,
    );
  });

  it("passes ArrayBuffer transferables for storeBlob and terminates on close", async () => {
    const opening = openBrowserSqlClient({ name: "sqlite-transfer" });
    const worker = MockWorker.instances[0]!;
    const initMessage = worker.messages[0]!.message;
    worker.reply({ id: initMessage.id, ok: true, result: null });
    const client = await opening;

    const payload = Uint8Array.from([1, 2, 3]).buffer;
    const storeBlobPromise = client.storeBlob("blob-1", payload);
    const storeMessage = worker.messages[1]!;
    expect(storeMessage.message).toMatchObject({
      method: "storeBlob",
      payload: { id: "blob-1", data: payload },
    });
    expect(storeMessage.transfer).toEqual([payload]);
    worker.reply({ id: storeMessage.message.id, ok: true, result: null });
    await storeBlobPromise;

    const closePromise = client.close();
    const closeMessage = worker.messages[2]!;
    expect(closeMessage.message.method).toBe("close");
    worker.reply({ id: closeMessage.message.id, ok: true, result: null });
    await closePromise;

    expect(worker.terminated).toBe(true);
  });
});
