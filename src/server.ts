import type { Config, ModelRoute, Upstream } from "./config/schema.ts";
import { errors } from "./pivot/errors.ts";
import { forwardChatCompletion } from "./upstream/client.ts";

interface Route {
  route: ModelRoute;
  upstream: Upstream;
}

function buildRouteTable(config: Config): Map<string, Route> {
  const upstreams = new Map(config.upstreams.map((u) => [u.name, u]));
  const table = new Map<string, Route>();
  for (const route of config.models) {
    // config validation guarantees the upstream exists
    table.set(route.expose, { route, upstream: upstreams.get(route.upstream)! });
  }
  return table;
}

function parseListen(listen: string): { hostname: string; port: number } {
  const sep = listen.lastIndexOf(":");
  const hostname = sep === -1 ? listen : listen.slice(0, sep);
  const port = sep === -1 ? 4100 : Number(listen.slice(sep + 1));
  if (!hostname || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid listen address: "${listen}" (expected host:port)`);
  }
  return { hostname, port };
}

export interface ServerOptions {
  /** Overrides the configured port; 0 picks a free port (used by tests). */
  port?: number;
}

export function createServer(config: Config, options: ServerOptions = {}) {
  const { hostname, port } = parseListen(config.listen);
  const routes = buildRouteTable(config);
  const apiKeys = new Set(config.api_keys);
  const startedAt = Math.floor(Date.now() / 1000);

  function authorized(req: Request): boolean {
    if (apiKeys.size === 0) return true;
    const header = req.headers.get("authorization") ?? "";
    return header.startsWith("Bearer ") && apiKeys.has(header.slice("Bearer ".length));
  }

  function listModels(): Response {
    return Response.json({
      object: "list",
      data: [...routes.keys()].map((id) => ({
        id,
        object: "model",
        created: startedAt,
        owned_by: "foxfence",
      })),
    });
  }

  async function chatCompletions(req: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await req.json();
    } catch (e) {
      return errors.invalidJson(e instanceof Error ? e.message : String(e));
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return errors.invalidRequest("Request body must be a JSON object.");
    }
    const request = body as Record<string, unknown>;
    if (typeof request.model !== "string" || request.model.length === 0) {
      return errors.invalidRequest("you must provide a model parameter", "model");
    }
    const resolved = routes.get(request.model);
    if (!resolved) return errors.modelNotFound(request.model);
    return forwardChatCompletion(request, resolved.route, resolved.upstream);
  }

  return Bun.serve({
    hostname,
    port: options.port ?? port,
    // LLM streams can stay quiet for a long time between tokens
    idleTimeout: 0,
    async fetch(req) {
      const { pathname } = new URL(req.url);

      if (pathname === "/healthz") {
        return req.method === "GET"
          ? Response.json({ status: "ok" })
          : errors.methodNotAllowed(req.method, pathname);
      }

      if (!authorized(req)) return errors.invalidApiKey();

      if (pathname === "/v1/models") {
        return req.method === "GET" ? listModels() : errors.methodNotAllowed(req.method, pathname);
      }
      if (pathname === "/v1/chat/completions") {
        return req.method === "POST"
          ? chatCompletions(req)
          : errors.methodNotAllowed(req.method, pathname);
      }
      return errors.notFound(pathname);
    },
  });
}
