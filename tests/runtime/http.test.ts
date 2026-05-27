import type { ConvexModuleRegistry } from "@embedded/kernel/modules";
import {
  createEmbeddedRuntime,
  type EmbeddedRuntime,
} from "@embedded/runtime/embedded";
import { remoteOnly } from "@embedded/server/markers";
import type { TestFixtures } from "@tests/testkit";
import { describe, expect, it } from "@tests/testkit";
import { httpActionGeneric, httpRouter } from "convex/server";

const echoAction = httpActionGeneric(async (_ctx, request: Request) => {
  const body = request.method === "GET" ? null : await request.text();
  return new Response(
    JSON.stringify({ method: request.method, url: request.url, body }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
});

const helloAction = httpActionGeneric(
  async () =>
    new Response("hello", {
      status: 200,
      headers: { "content-type": "text/plain" },
    }),
);

const throwingAction = httpActionGeneric(async () => {
  throw new Error("intentional handler explosion");
});

const profileAction = httpActionGeneric(async (_ctx, request: Request) => {
  const path = new URL(request.url).pathname;
  return new Response(`profile:${path}`, {
    status: 200,
    headers: { "content-type": "text/plain" },
  });
});

function makeRouterModule() {
  const http = httpRouter();
  http.route({ path: "/api/hello", method: "GET", handler: helloAction });
  http.route({ path: "/api/echo", method: "POST", handler: echoAction });
  http.route({ path: "/api/echo", method: "PUT", handler: echoAction });
  http.route({ path: "/api/explode", method: "GET", handler: throwingAction });
  http.route({
    pathPrefix: "/api/profile/",
    method: "GET",
    handler: profileAction,
  });
  return { default: http };
}

const HTTP_MODULES: ConvexModuleRegistry = {
  "_generated/api": () => Promise.resolve({}),
  http: () => Promise.resolve(makeRouterModule()),
};

async function startRuntime(
  track: TestFixtures["track"],
  modules: ConvexModuleRegistry,
): Promise<EmbeddedRuntime> {
  const runtime = createEmbeddedRuntime({ convex: { modules } });
  track({ close: () => runtime.shutdown() });
  await runtime.hydrate();
  return runtime;
}

function request(path: string, init?: RequestInit): Request {
  return new Request(`http://embedded.local${path}`, init);
}

describe("EmbeddedRuntime.dispatchHttpRequest", () => {
  it("routes an exact GET to the registered handler", async ({ track }) => {
    const runtime = await startRuntime(track, HTTP_MODULES);

    const response = await runtime.dispatchHttpRequest(
      request("/api/hello", { method: "GET" }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("hello");
  });

  it("returns 404 for unmatched paths", async ({ track }) => {
    const runtime = await startRuntime(track, HTTP_MODULES);

    const response = await runtime.dispatchHttpRequest(
      request("/api/missing", { method: "GET" }),
    );

    expect(response.status).toBe(404);
  });

  it("differentiates handlers by method on the same path", async ({
    track,
  }) => {
    const runtime = await startRuntime(track, HTTP_MODULES);

    const post = await runtime.dispatchHttpRequest(
      request("/api/echo", { method: "POST", body: "payload-1" }),
    );
    expect(post.status).toBe(200);
    const postBody = (await post.json()) as { method: string; body: string };
    expect(postBody.method).toBe("POST");
    expect(postBody.body).toBe("payload-1");

    const get404 = await runtime.dispatchHttpRequest(
      request("/api/echo", { method: "GET" }),
    );
    expect(get404.status).toBe(404);
  });

  it("routes through path prefixes (longest match)", async ({ track }) => {
    const runtime = await startRuntime(track, HTTP_MODULES);

    const response = await runtime.dispatchHttpRequest(
      request("/api/profile/abc123", { method: "GET" }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("profile:/api/profile/abc123");
  });

  it("HEAD requests run GET handlers and strip the body", async ({ track }) => {
    const runtime = await startRuntime(track, HTTP_MODULES);

    const response = await runtime.dispatchHttpRequest(
      request("/api/hello", { method: "HEAD" }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });

  it("returns 500 with the error message when the handler throws", async ({
    track,
  }) => {
    const runtime = await startRuntime(track, HTTP_MODULES);

    const response = await runtime.dispatchHttpRequest(
      request("/api/explode", { method: "GET" }),
    );

    expect(response.status).toBe(500);
    expect(await response.text()).toContain("intentional handler explosion");
  });
});

describe("EmbeddedRuntime.dispatchHttpRequest with remoteOnly handlers", () => {
  it("returns 404 for routes whose handler is wrapped in remoteOnly()", async ({
    track,
  }) => {
    const localHello = httpActionGeneric(
      async () => new Response("local-hello", { status: 200 }),
    );
    const stripeWebhook = remoteOnly(
      httpActionGeneric(
        async () => new Response("should never run locally", { status: 200 }),
      ),
    );

    const http = httpRouter();
    http.route({ path: "/api/hello", method: "GET", handler: localHello });
    http.route({
      path: "/webhooks/stripe",
      method: "POST",
      handler: stripeWebhook,
    });

    const runtime = await startRuntime(track, {
      "_generated/api": () => Promise.resolve({}),
      http: () => Promise.resolve({ default: http }),
    });

    const local = await runtime.dispatchHttpRequest(
      request("/api/hello", { method: "GET" }),
    );
    expect(local.status).toBe(200);
    expect(await local.text()).toBe("local-hello");

    const remote = await runtime.dispatchHttpRequest(
      request("/webhooks/stripe", { method: "POST", body: "{}" }),
    );
    expect(remote.status).toBe(404);
  });
});

describe("EmbeddedRuntime.dispatchHttpRequest without a router", () => {
  it("returns 404 when convex/http is not in the module registry", async ({
    track,
  }) => {
    const runtime = await startRuntime(track, {
      "_generated/api": () => Promise.resolve({}),
    });

    const response = await runtime.dispatchHttpRequest(
      request("/anything", { method: "GET" }),
    );

    expect(response.status).toBe(404);
  });
});
