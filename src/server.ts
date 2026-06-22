import type { Config, ModelRoute, Upstream } from "./config/schema.ts";
import { errors } from "./pivot/errors.ts";
import { handleChatCompletion, type PipelineOptions } from "./pipeline.ts";
import { buildDetectors } from "./security/registry.ts";
import { AuditLog } from "./audit.ts";
import { CapabilityStore } from "./shim/probe.ts";
import { Metrics } from "./metrics.ts";
import { toChatRequest, toResponsesObject } from "./pivot/responses.ts";
import { resolveProfiles } from "./config/profiles.ts";

interface Route {
  route: ModelRoute;
  upstream: Upstream;
}

function buildRouteTable(config: Config): Map<string, Route> {
  const upstreams = new Map(config.upstreams.map((u) => [u.name, u]));
  // Resolve each route's `profile` (registry id or inline) to a concrete
  // object so strategy selection reads it directly off the route.
  const profiles = resolveProfiles(config);
  const table = new Map<string, Route>();
  for (const route of config.models) {
    // config validation guarantees the upstream exists
    const resolved = profiles.get(route.expose);
    const withProfile = resolved ? { ...route, profile: resolved } : route;
    table.set(route.expose, { route: withProfile, upstream: upstreams.get(route.upstream)! });
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

  const { detectors, warnings } = buildDetectors(config);
  for (const warning of warnings) console.warn(`foxfence: ${warning}`);
  const capabilities = new CapabilityStore();
  const metrics = config.metrics?.enabled ? new Metrics() : null;
  const pipeline: PipelineOptions = {
    detectors,
    onDetectorError: config.security?.on_detector_error ?? "block",
    audit: config.audit?.file ? AuditLog.open(config.audit.file) : null,
    auditIncludeContent: config.audit?.include_content ?? false,
    capabilities,
    metrics,
  };

  // probe: startup — eager capability detection, fire-and-forget (§6.1)
  for (const { route, upstream } of routes.values()) {
    if (route.probe === "startup") {
      capabilities.resolve(route, upstream).then(
        (caps) => console.log(`foxfence: probed ${upstream.name}/${route.model}: ${caps.toolCalling}`),
        (e) => console.warn(`foxfence: startup probe failed for ${upstream.name}/${route.model}: ${e.message}`),
      );
    }
  }

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
    return handleChatCompletion(request, resolved.route, resolved.upstream, pipeline);
  }

  async function responses(req: Request): Promise<Response> {
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
    if (request.stream === true) {
      return errors.invalidRequest(
        "streaming is not yet supported on /v1/responses; use stream:false or /v1/chat/completions",
        "stream",
      );
    }
    const resolved = routes.get(request.model);
    if (!resolved) return errors.modelNotFound(request.model);

    const chatReq = toChatRequest(request);
    const chatRes = await handleChatCompletion(chatReq, resolved.route, resolved.upstream, pipeline);
    if (chatRes.status !== 200) return chatRes; // OpenAI-format error passes through
    const chatBody = (await chatRes.json()) as Record<string, unknown>;

    const headers = new Headers({ "content-type": "application/json" });
    for (const h of ["x-foxfence-blocked", "x-foxfence-repairs"]) {
      const v = chatRes.headers.get(h);
      if (v !== null) headers.set(h, v);
    }
    return new Response(JSON.stringify(toResponsesObject(chatBody, request.model)), { status: 200, headers });
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

      // Prometheus scrape endpoint (opt-in, unauthenticated like /healthz —
      // network-restrict it). 404 when metrics are disabled.
      if (pathname === "/metrics") {
        if (!metrics) return errors.notFound(pathname);
        return req.method === "GET"
          ? new Response(metrics.render(), {
              headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" },
            })
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
      if (pathname === "/v1/responses") {
        return req.method === "POST" ? responses(req) : errors.methodNotAllowed(req.method, pathname);
      }
      return errors.notFound(pathname);
    },
  });
}
