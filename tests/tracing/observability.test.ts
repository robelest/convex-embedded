import { EmbeddedRuntime } from "@embedded/runtime/embedded";
import { remoteOnly } from "@embedded/server/markers";
import { installInMemoryTracing } from "@embedded/tracing/memory";
import { recordCounter, registerGauge } from "@embedded/tracing/metrics";
import { afterEach, beforeEach, describe, expect, it } from "@tests/testkit";
import { httpActionGeneric, httpRouter } from "convex/server";

describe("tracing/observability", () => {
  let handle: ReturnType<typeof installInMemoryTracing>;

  beforeEach(() => {
    handle = installInMemoryTracing({ capacity: 256 });
  });

  afterEach(async () => {
    await handle.close();
  });

  it("captures counters via the in-memory metric exporter", async () => {
    recordCounter("test.counter", { label: "first" });
    recordCounter("test.counter", { label: "first" });
    recordCounter("test.counter", { label: "second" });

    const points = await handle.getMetrics();
    const testPoints = points.filter(
      (p) => p.name === "convex.embedded.test.counter",
    );
    expect(testPoints.length).toBeGreaterThanOrEqual(2);
    const first = testPoints.find((p) => p.attributes.label === "first");
    const second = testPoints.find((p) => p.attributes.label === "second");
    expect(first?.value).toBe(2);
    expect(second?.value).toBe(1);
    expect(first?.kind).toBe("counter");
  });

  it("captures observable gauges via the in-memory metric exporter", async () => {
    let depth = 0;
    const unregister = registerGauge("test.depth", () => depth);
    depth = 7;

    const points = await handle.getMetrics();
    const stateGauges = points.filter(
      (p) => p.name === "convex.embedded.runtime.state",
    );
    const ours = stateGauges.find((p) => p.attributes.state === "test.depth");
    expect(ours?.value).toBe(7);
    expect(ours?.kind).toBe("gauge");

    unregister();
  });

  it("emits http.dispatch counters with result attribute via real runtime", async () => {
    const local = httpActionGeneric(
      async () =>
        new Response("hello", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
    );
    const blockedRemote = remoteOnly(
      httpActionGeneric(async () => new Response("nope", { status: 200 })),
    );
    const http = httpRouter();
    http.route({ path: "/api/hello", method: "GET", handler: local });
    http.route({
      path: "/webhooks/stripe",
      method: "POST",
      handler: blockedRemote,
    });

    const runtime = new EmbeddedRuntime({
      convex: {
        modules: {
          "_generated/api": () => Promise.resolve({}),
          http: () => Promise.resolve({ default: http }),
        },
      },
    });
    await runtime.hydrate();

    try {
      await runtime.dispatchHttpRequest(
        new Request("http://embedded.local/api/hello", { method: "GET" }),
      );
      await runtime.dispatchHttpRequest(
        new Request("http://embedded.local/webhooks/stripe", {
          method: "POST",
          body: "{}",
        }),
      );
      await runtime.dispatchHttpRequest(
        new Request("http://embedded.local/api/missing", { method: "GET" }),
      );

      const points = await handle.getMetrics();
      const dispatches = points.filter(
        (p) => p.name === "convex.embedded.http.dispatch",
      );
      const byResult = new Map(
        dispatches.map((p) => [String(p.attributes.result), p.value]),
      );
      expect(byResult.get("ok")).toBe(1);
      expect(byResult.get("remote_only")).toBe(1);
      expect(byResult.get("not_found")).toBe(1);
    } finally {
      runtime.shutdown();
    }
  });

  it("attaches state-transition events to the http dispatch span", async () => {
    const blocked = remoteOnly(
      httpActionGeneric(async () => new Response("nope", { status: 200 })),
    );
    const http = httpRouter();
    http.route({
      path: "/webhooks/stripe",
      method: "POST",
      handler: blocked,
    });

    const runtime = new EmbeddedRuntime({
      convex: {
        modules: {
          "_generated/api": () => Promise.resolve({}),
          http: () => Promise.resolve({ default: http }),
        },
      },
    });
    await runtime.hydrate();

    try {
      handle.clearSpans();
      await runtime.dispatchHttpRequest(
        new Request("http://embedded.local/webhooks/stripe", {
          method: "POST",
          body: "{}",
        }),
      );
      const dispatchSpans = handle
        .getSpans()
        .filter((s) => s.name === "convex-embedded.http.dispatch");
      expect(dispatchSpans).toHaveLength(1);
      const events = dispatchSpans[0]!.events.map((e) => e.name);
      expect(events).toContain("http.skipped_remote_only");
    } finally {
      runtime.shutdown();
    }
  });
});
