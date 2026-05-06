import { EmbeddedRuntime } from "@embedded/runtime/embedded";
import { afterEach, beforeEach, describe, expect, it } from "@tests/testkit";
import {
  httpActionGeneric,
  httpRouter,
  type GenericActionCtx,
} from "convex/server";

const echoAction = httpActionGeneric(async (_ctx, request: Request) => {
  const body = request.method === "GET" ? null : await request.text();
  return new Response(
    JSON.stringify({
      method: request.method,
      url: request.url,
      body,
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
});

const helloAction = httpActionGeneric(
  async (_ctx: GenericActionCtx<any>) =>
    new Response("hello", {
      status: 200,
      headers: { "content-type": "text/plain" },
    }),
);

const throwingAction = httpActionGeneric(async () => {
  throw new Error("intentional handler explosion");
});

const profileAction = httpActionGeneric(
  async (_ctx, request: Request) => {
    const path = new URL(request.url).pathname;
    return new Response(`profile:${path}`, {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  },
);

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

const HTTP_MODULES: Record<string, () => Promise<unknown>> = {
  "_generated/api": () => Promise.resolve({}),
  http: () => Promise.resolve(makeRouterModule()),
};

describe("EmbeddedRuntime.dispatchHttpRequest", () => {
  let runtime: EmbeddedRuntime;

  beforeEach(async () => {
    runtime = new EmbeddedRuntime({ convex: { modules: HTTP_MODULES } });
    await runtime.hydrate();
  });

  afterEach(() => {
    runtime.shutdown();
  });

  it("routes an exact GET to the registered handler", async () => {
    const response = await runtime.dispatchHttpRequest(
      new Request("http://embedded.local/api/hello", { method: "GET" }),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("hello");
  });

  it("returns 404 for unmatched paths", async () => {
    const response = await runtime.dispatchHttpRequest(
      new Request("http://embedded.local/api/missing", { method: "GET" }),
    );
    expect(response.status).toBe(404);
  });

  it("differentiates handlers by method on the same path", async () => {
    const post = await runtime.dispatchHttpRequest(
      new Request("http://embedded.local/api/echo", {
        method: "POST",
        body: "payload-1",
      }),
    );
    expect(post.status).toBe(200);
    const postBody = (await post.json()) as { method: string; body: string };
    expect(postBody.method).toBe("POST");
    expect(postBody.body).toBe("payload-1");

    const get404 = await runtime.dispatchHttpRequest(
      new Request("http://embedded.local/api/echo", { method: "GET" }),
    );
    expect(get404.status).toBe(404);
  });

  it("routes through path prefixes (longest match)", async () => {
    const response = await runtime.dispatchHttpRequest(
      new Request("http://embedded.local/api/profile/abc123", {
        method: "GET",
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("profile:/api/profile/abc123");
  });

  it("HEAD requests run GET handlers and strip the body", async () => {
    const response = await runtime.dispatchHttpRequest(
      new Request("http://embedded.local/api/hello", { method: "HEAD" }),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });

  it("returns 500 with the error message when the handler throws", async () => {
    const response = await runtime.dispatchHttpRequest(
      new Request("http://embedded.local/api/explode", { method: "GET" }),
    );
    expect(response.status).toBe(500);
    expect(await response.text()).toContain("intentional handler explosion");
  });
});

describe("EmbeddedRuntime.dispatchHttpRequest without a router", () => {
  it("returns 404 when convex/http is not in the module registry", async () => {
    const runtime = new EmbeddedRuntime({
      convex: { modules: { "_generated/api": () => Promise.resolve({}) } },
    });
    await runtime.hydrate();
    try {
      const response = await runtime.dispatchHttpRequest(
        new Request("http://embedded.local/anything", { method: "GET" }),
      );
      expect(response.status).toBe(404);
    } finally {
      runtime.shutdown();
    }
  });
});
