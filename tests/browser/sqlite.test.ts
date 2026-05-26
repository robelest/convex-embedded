import { openBrowserSqlClient } from "@embedded/browser/sqlite/client";
import type {
  StorageWorkerRequest,
  StorageWorkerResponse,
} from "@embedded/browser/sqlite/protocol";
import { installInMemoryTracing } from "@embedded/tracing/memory";
import type { BufferingTracingHandle } from "@embedded/tracing/memory";
import { resetMetricsRegistrations } from "@embedded/tracing/metrics";
import { withFakeTimers } from "@tests/helpers/time";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "@tests/testkit";

type MessageHandler = (event: MessageEvent<StorageWorkerResponse>) => void;
type ErrorHandler = (event: ErrorEvent) => void;

interface RecordedMessage {
  message: StorageWorkerRequest;
  transfer: Array<Transferable>;
}

class MockWorker {
  static instances: MockWorker[] = [];

  readonly messageHandlers = new Set<MessageHandler>();
  readonly errorHandlers = new Set<ErrorHandler>();
  readonly postMessage = vi.fn(
    (message: StorageWorkerRequest, transfer?: Array<Transferable>) => {
      this.messages.push({ message, transfer: transfer ?? [] });
    },
  );
  readonly messages: RecordedMessage[] = [];
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
  ): void {
    if (type === "message") {
      this.messageHandlers.add(handler as MessageHandler);
      return;
    }
    this.errorHandlers.add(handler as ErrorHandler);
  }

  terminate(): void {
    this.terminated = true;
  }

  reply(response: StorageWorkerResponse): void {
    for (const handler of this.messageHandlers) {
      handler({ data: response } as MessageEvent<StorageWorkerResponse>);
    }
  }

  fail(error: Error): void {
    for (const handler of this.errorHandlers) {
      handler({ error, message: error.message } as ErrorEvent);
    }
  }

  static reset(): void {
    MockWorker.instances = [];
  }
}

function firstWorker(): MockWorker {
  const worker = MockWorker.instances[0];
  expect(worker).toBeDefined();
  return worker!;
}

async function openInitializedClient(name: string) {
  const opening = openBrowserSqlClient({ name });
  const worker = firstWorker();
  const initMessage = worker.messages[0]!.message;
  worker.reply({ id: initMessage.id, ok: true, result: null });
  const client = await opening;
  return { client, worker };
}

describe("openBrowserSqlClient", () => {
  beforeEach(() => {
    MockWorker.reset();
    vi.stubGlobal("Worker", MockWorker as unknown as typeof Worker);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    MockWorker.reset();
  });

  it("terminates the worker when init fails", async () => {
    const opening = openBrowserSqlClient({ name: "sqlite-init-fail" });
    const worker = firstWorker();
    const initMessage = worker.messages[0]!.message;

    expect(initMessage).toMatchObject({
      method: "init",
      payload: { name: "sqlite-init-fail" },
    });

    worker.reply({ id: initMessage.id, ok: false, error: "init failed" });

    await expect(opening).rejects.toThrow("init failed");
    expect(worker.terminated).toBe(true);
  });

  it("rejects in-flight requests when the worker errors", async () => {
    const { client, worker } = await openInitializedClient(
      "sqlite-worker-error",
    );

    const getMetaPromise = client.getMeta();
    const requestMessage = worker.messages[1]!.message;
    expect(requestMessage.method).toBe("getMeta");

    worker.fail(new Error("worker crashed"));

    await expect(getMetaPromise).rejects.toThrow("worker crashed");
  });

  it("times out requests that never receive a response", async () => {
    await withFakeTimers(async () => {
      const { client } = await openInitializedClient("sqlite-timeout");

      const pending = client.getMeta();
      const rejection = pending.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(15_000);

      const error = await rejection;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(
        /timed out after 15000ms.*getMeta/,
      );
    });
  });

  it("records worker queue-wait + exec histograms tagged by method and lane", async () => {
    let handle: BufferingTracingHandle | null = null;
    try {
      handle = installInMemoryTracing();
      resetMetricsRegistrations();
      const { client, worker } = await openInitializedClient("sqlite-metrics");

      const readPromise = client.getMeta();
      const readMessage = worker.messages[1]!.message;
      worker.reply({
        id: readMessage.id,
        ok: true,
        result: null,
        timing: { queueWaitMs: 42, execMs: 3 },
      });
      await readPromise;

      const writePromise = client.execute("INSERT INTO t VALUES (1)");
      const writeMessage = worker.messages[2]!.message;
      worker.reply({
        id: writeMessage.id,
        ok: true,
        result: null,
        timing: { queueWaitMs: 7, execMs: 11 },
      });
      await writePromise;

      const metrics = await handle.getMetrics();
      const queueWait = metrics.filter(
        (point) => point.name === "convex.embedded.sqlite.queue_wait_ms",
      );
      expect(
        queueWait.some(
          (point) =>
            point.attributes.method === "getMeta" &&
            point.attributes.lane === "read",
        ),
      ).toBe(true);
      expect(
        queueWait.some(
          (point) =>
            point.attributes.method === "execute" &&
            point.attributes.lane === "write",
        ),
      ).toBe(true);
      expect(
        metrics.some(
          (point) => point.name === "convex.embedded.sqlite.exec_ms",
        ),
      ).toBe(true);
    } finally {
      if (handle) await handle.close();
    }
  });

  it("passes ArrayBuffer transferables for storeBlob and terminates on close", async () => {
    const { client, worker } = await openInitializedClient("sqlite-transfer");

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
