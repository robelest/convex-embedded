import type { ModuleLoader } from "@/kernel/modules";
import type { UdfExecutor } from "@/kernel/udf";
import { createLogger } from "@/shared/logger";

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

export interface HttpDispatcher {
  dispatch(request: Request): Promise<Response>;
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

export async function createHttpDispatcher(
  moduleLoader: ModuleLoader,
  executor: UdfExecutor,
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

  const dispatch = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    if (
      !ROUTABLE_HTTP_METHODS.includes(method as RoutableMethod) &&
      method !== "HEAD"
    ) {
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
      return new Response("Not Found", {
        status: 404,
        headers: { "content-type": "text/plain" },
      });
    }
    const [action, routedMethod, routedPath] = match;
    log.debug(
      `dispatch ${method} ${url.pathname} -> ${routedMethod} ${routedPath}`,
    );
    try {
      const response = await executor.executeHttpAction(action, request);
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
      return new Response(message, {
        status: 500,
        headers: { "content-type": "text/plain" },
      });
    }
  };

  return {
    dispatch,
    hasRoutes: () => true,
  };
}
