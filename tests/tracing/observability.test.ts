import { EmbeddedRuntime } from "@embedded/runtime/embedded";
import { remoteOnly } from "@embedded/server/markers";
import { installInMemoryTracing } from "@embedded/tracing/memory";
import { recordCounter, registerGauge } from "@embedded/tracing/metrics";
import { describe, expect, it, type TestFixtures } from "@tests/testkit";
import { httpActionGeneric, httpRouter } from "convex/server";

function startRuntime(
  track: TestFixtures["track"],
  router: ReturnType<typeof httpRouter>,
): Promise<EmbeddedRuntime> {
  const runtime = new EmbeddedRuntime({
    convex: {
      modules: {
        "_generated/api": () => Promise.resolve({}),
        http: () => Promise.resolve({ default: router }),
      },
    },
  });
  track({ close: () => runtime.shutdown() });
  return runtime.hydrate().then(() => runtime);
}

describe("tracing/observability", () => {
  it("captures counters via the in-memory metric exporter", async ({
    track,
  }) => {
    const handle = track(installInMemoryTracing({ capacity: 256 }));
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

  it("captures observable gauges via the in-memory metric exporter", async ({
    track,
  }) => {
    const handle = track(installInMemoryTracing({ capacity: 256 }));
    let depth = 0;
    const unregister = registerGauge("test.depth", () => depth);
    depth = 7;

    const points = await handle.getMetrics();

    const ours = points
      .filter((p) => p.name === "convex.embedded.runtime.state")
      .find((p) => p.attributes.state === "test.depth");
    expect(ours?.value).toBe(7);
    expect(ours?.kind).toBe("gauge");

    unregister();
  });

  it("emits http.dispatch counters with a result attribute via the real runtime", async ({
    track,
  }) => {
    const handle = track(installInMemoryTracing({ capacity: 256 }));
    const http = httpRouter();
    http.route({
      path: "/api/hello",
      method: "GET",
      handler: httpActionGeneric(
        async () =>
          new Response("hello", {
            status: 200,
            headers: { "content-type": "text/plain" },
          }),
      ),
    });
    http.route({
      path: "/webhooks/stripe",
      method: "POST",
      handler: remoteOnly(
        httpActionGeneric(async () => new Response("nope", { status: 200 })),
      ),
    });
    const runtime = await startRuntime(track, http);

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
    const byResult = new Map(
      points
        .filter((p) => p.name === "convex.embedded.http.dispatch")
        .map((p) => [String(p.attributes.result), p.value]),
    );
    expect(byResult.get("ok")).toBe(1);
    expect(byResult.get("remote_only")).toBe(1);
    expect(byResult.get("not_found")).toBe(1);
  });

  it("attaches state-transition events to the http dispatch span", async ({
    track,
  }) => {
    const handle = track(installInMemoryTracing({ capacity: 256 }));
    const http = httpRouter();
    http.route({
      path: "/webhooks/stripe",
      method: "POST",
      handler: remoteOnly(
        httpActionGeneric(async () => new Response("nope", { status: 200 })),
      ),
    });
    const runtime = await startRuntime(track, http);

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
    expect(dispatchSpans[0]!.events.map((e) => e.name)).toContain(
      "http.skipped_remote_only",
    );
  });
});
