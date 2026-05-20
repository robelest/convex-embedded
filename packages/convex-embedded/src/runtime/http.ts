import type { ModuleLoader } from "@/kernel/modules";
import type { UdfExecutor } from "@/kernel/udf";
import { createLogger } from "@/shared/logger";
import { isRemoteOnly } from "@/shared/route";
import { recordCounter } from "@/tracing/metrics";
import { withSpan } from "@/tracing/spans";

const log = createLogger("http");

const ROUTABLE_HTTP_METHODS = [
  "GET",
  "POST",
  "PUT",
  "DELETE",
  "OPTIONS",
  "PATCH",
] as const;
type RoutableMethod = (typeof ROUTABLE_HTTP_METHODS)[number];

interface HttpRouterLike {
  lookup?: (
    path: string,
    method: RoutableMethod | "HEAD",
  ) =>
    | readonly [
        { invokeHttpAction?: (request: Request) => Promise<Response> },
        RoutableMethod,
        string,
      ]
    | null;
  exactRoutes?: Map<string, Map<RoutableMethod, unknown>>;
  prefixRoutes?: Map<RoutableMethod, Map<string, unknown>>;
}

/**
 * The runtime's local httpAction dispatcher. Built from the user's
 * `convex/http.ts` route table, returned by {@link createHttpDispatcher},
 * and invoked from `client.dispatchHttpRequest(request)` /
 * `runtime.dispatchHttpRequest(request)`.
 *
 * @public
 */
export interface HttpDispatcher {
  /**
   * Match a `Request` against the user's `httpRouter` and run the
   * matched handler under the action runtime. Returns a 404 when no
   * route matches or when the matched handler is wrapped in
   * `remoteOnly()`. Returns 500 when a handler throws.
   */
  dispatch(request: Request): Promise<Response>;
  /** Whether any routes are registered. False for projects without `convex/http.ts`. */
  hasRoutes(): boolean;
}

const NO_ROUTES_DISPATCHER: HttpDispatcher = {
  dispatch: () =>
    Promise.resolve(
      new Response("Not Found", {
        status: 404,
        headers: { "content-type": "text/plain" },
      }),
    ),
  hasRoutes: () => false,
};

/**
 * Build the embedded runtime's httpAction dispatcher. Loads the user's
 * `convex/http.ts` (if present) via the module loader and freezes the
 * route table at startup. When the registry has no `http` module or
 * the default export isn't an `HttpRouter`, returns a no-op dispatcher
 * that always returns 404.
 *
 * Called once per runtime by the hydration path; not for direct app use.
 *
 * @internal
 */
export async function createHttpDispatcher(
  moduleLoader: ModuleLoader,
  executor: UdfExecutor,
  runExclusive: <T>(fn: () => Promise<T>) => Promise<T> = (fn) => fn(),
): Promise<HttpDispatcher> {
  let mod: unknown;
  try {
    mod = await moduleLoader.load("http");
  } catch {
    return NO_ROUTES_DISPATCHER;
  }
  const router =
    ((mod as { default?: unknown }).default as HttpRouterLike | undefined) ??
    null;
  if (!router) return NO_ROUTES_DISPATCHER;
  if (typeof router.lookup !== "function") {
    log.warn("convex/http default export is not an HttpRouter; ignoring");
    return NO_ROUTES_DISPATCHER;
  }
  if (
    (!router.exactRoutes || router.exactRoutes.size === 0) &&
    (!router.prefixRoutes || router.prefixRoutes.size === 0)
  ) {
    return NO_ROUTES_DISPATCHER;
  }

  const dispatch = (request: Request): Promise<Response> =>
    withSpan("convex-embedded.http.dispatch", async (span) => {
      const url = new URL(request.url);
      const method = request.method.toUpperCase();
      span.setAttributes({
        "http.method": method,
        "http.path": url.pathname,
      });
      if (
        !ROUTABLE_HTTP_METHODS.includes(method as RoutableMethod) &&
        method !== "HEAD"
      ) {
        recordCounter("http.dispatch", { result: "method_not_allowed" });
        span.addEvent("http.method_not_allowed", { "http.method": method });
        return new Response(`Method Not Allowed: ${method}`, {
          status: 405,
          headers: { "content-type": "text/plain" },
        });
      }
      const match = router.lookup!(
        url.pathname,
        method as RoutableMethod | "HEAD",
      );
      if (!match) {
        recordCounter("http.dispatch", { result: "not_found" });
        span.addEvent("http.not_found");
        return new Response("Not Found", {
          status: 404,
          headers: { "content-type": "text/plain" },
        });
      }
      const [action, routedMethod, routedPath] = match;
      span.setAttributes({
        "http.route.method": routedMethod,
        "http.route.path": routedPath,
      });
      if (isRemoteOnly(action)) {
        log.debug(
          `dispatch ${method} ${url.pathname} matched remoteOnly handler ${routedPath}; returning 404`,
        );
        recordCounter("http.dispatch", { result: "remote_only" });
        span.addEvent("http.skipped_remote_only", {
          "http.route.path": routedPath,
        });
        return new Response("Not Found", {
          status: 404,
          headers: { "content-type": "text/plain" },
        });
      }
      log.debug(
        `dispatch ${method} ${url.pathname} -> ${routedMethod} ${routedPath}`,
      );
      try {
        const response = await runExclusive(() =>
          executor.executeHttpAction(action, request),
        );
        span.setAttribute("http.status_code", response.status);
        recordCounter("http.dispatch", {
          result: "ok",
          "http.status_code": response.status,
        });
        if (method === "HEAD") {
          return new Response(null, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        }
        return response;
      } catch (error) {
        log.error(`http handler ${routedMethod} ${routedPath} threw`, error);
        const message = error instanceof Error ? error.message : String(error);
        recordCounter("http.dispatch", { result: "error" });
        span.addEvent("http.handler_threw", {
          "convex.error.message": message,
        });
        return new Response(message, {
          status: 500,
          headers: { "content-type": "text/plain" },
        });
      }
    });

  return {
    dispatch,
    hasRoutes: () => true,
  };
}
