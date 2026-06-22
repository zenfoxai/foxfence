import { z } from "zod";

export const UpstreamSchema = z.object({
  name: z.string().min(1),
  base_url: z.url(),
  api_key: z.string().optional(),
  // The server's constrained-decoding mechanism (§6.2), if any. Enables the
  // `constrained` strategy: response_format = OpenAI/vLLM json_schema,
  // guided_json = vLLM's extra body field.
  constrained: z.enum(["response_format", "guided_json"]).optional(),
});

// A model profile (§4 ModelProfile / §6.1): pins a strategy and/or describes
// quirks the auto probe can't see. Referenced by `profile:` on a route,
// either by registry id (string) or inline.
export const ModelProfileSchema = z.looseObject({
  id: z.string().min(1).optional(),
  capabilities: z
    .looseObject({
      toolCalling: z.enum(["native", "weak", "none"]).optional(),
      parallelToolCalls: z.boolean().optional(),
      jsonMode: z.enum(["native", "prompted", "none"]).optional(),
    })
    .optional(),
  pinStrategy: z.enum(["native", "json-prompted", "constrained", "react"]).optional(),
  contextWindow: z.number().int().positive().optional(),
  chatTemplateQuirks: z.array(z.string()).default([]),
});

export const ModelRouteSchema = z.looseObject({
  expose: z.string().min(1),
  upstream: z.string().min(1),
  model: z.string().min(1),
  // "react" (v1.0) is accepted by the schema and rejected with a clear
  // message in the config cross-checks below.
  shim: z.enum(["auto", "native", "constrained", "json-prompted", "react"]).default("auto"),
  probe: z.enum(["lazy", "startup", "off"]).default("lazy"),
  repair: z
    .looseObject({ max_attempts: z.number().int().min(0).max(5).default(2) })
    .optional(),
  // Registry id (string) or an inline profile object.
  profile: z.union([z.string().min(1), ModelProfileSchema]).optional(),
});

export const DetectorActionSchema = z.enum(["pass", "flag", "mask", "block", "off"]);

export const ToolPolicyRuleSchema = z.looseObject({
  tool: z.string().min(1),
  args: z.record(z.string(), z.string()).optional(),
  action: z.enum(["allow", "block", "flag"]),
  message: z.string().optional(),
});

export const ToolPolicySchema = z.looseObject({
  default: z.enum(["allow", "deny"]).default("allow"),
  // Every rule is evaluated per tool call; a sane upper bound keeps the
  // per-request cost inside the <5 ms overhead budget (§9).
  rules: z.array(ToolPolicyRuleSchema).max(1000).default([]),
});

export const PhaseSchema = z.enum(["request", "response", "tool_call"]);

export const DetectorConfigSchema = z.looseObject({
  action: DetectorActionSchema.optional(),
  // When set, the detector POSTs content to this external classifier (§5.2).
  remote: z.url().optional(),
  // Phases the (remote) detector runs on; default [request].
  phases: z.array(PhaseSchema).optional(),
  // Only inspect segments from these message roles (e.g. [tool] for
  // tool-sourced injection). Omit to inspect all roles.
  roles: z.array(z.string().min(1)).optional(),
  timeout_ms: z.number().int().positive().max(60000).optional(),
  threshold: z.number().min(0).max(1).optional(),
});

export const SecuritySchema = z.looseObject({
  on_detector_error: z.enum(["block", "pass"]).default("block"),
  detectors: z.record(z.string(), DetectorConfigSchema).default({}),
  tool_policy: ToolPolicySchema.optional(),
});

export const AuditConfigSchema = z.looseObject({
  file: z.string().min(1).optional(),
  include_content: z.boolean().default(false),
});

export const MetricsConfigSchema = z.looseObject({
  enabled: z.boolean().default(false),
});

export const ConfigSchema = z
  .looseObject({
    listen: z.string().default("127.0.0.1:4100"),
    api_keys: z.array(z.string().min(1)).default([]),
    upstreams: z.array(UpstreamSchema).min(1),
    models: z.array(ModelRouteSchema).min(1),
    security: SecuritySchema.optional(),
    audit: AuditConfigSchema.optional(),
    metrics: MetricsConfigSchema.optional(),
    // Directory of community model profiles (YAML); resolved lazily, only
    // when a route references a profile by id.
    profiles_dir: z.string().min(1).optional(),
  })
  .check((ctx) => {
    const upstreamNames = new Set(ctx.value.upstreams.map((u) => u.name));
    if (upstreamNames.size !== ctx.value.upstreams.length) {
      ctx.issues.push({
        code: "custom",
        message: "duplicate upstream names",
        input: ctx.value.upstreams,
        path: ["upstreams"],
      });
    }
    const exposed = new Set<string>();
    ctx.value.models.forEach((m, i) => {
      if (exposed.has(m.expose)) {
        ctx.issues.push({
          code: "custom",
          message: `duplicate exposed model name "${m.expose}"`,
          input: m.expose,
          path: ["models", i, "expose"],
        });
      }
      exposed.add(m.expose);
      const upstream = ctx.value.upstreams.find((u) => u.name === m.upstream);
      if (!upstream) {
        ctx.issues.push({
          code: "custom",
          message: `model "${m.expose}" references unknown upstream "${m.upstream}"`,
          input: m.upstream,
          path: ["models", i, "upstream"],
        });
      }
      // The constrained strategy needs the upstream to declare its mechanism.
      const pinsConstrained =
        m.shim === "constrained" ||
        (typeof m.profile === "object" && m.profile?.pinStrategy === "constrained");
      if (pinsConstrained && upstream && !upstream.constrained) {
        ctx.issues.push({
          code: "custom",
          message: `model "${m.expose}" uses the constrained strategy but upstream "${m.upstream}" does not declare a \`constrained:\` mechanism (response_format | guided_json)`,
          input: m.shim,
          path: ["models", i, "shim"],
        });
      }
    });
  });

export type Config = z.infer<typeof ConfigSchema>;
export type Upstream = z.infer<typeof UpstreamSchema>;
export type ModelRoute = z.infer<typeof ModelRouteSchema>;
export type ModelProfile = z.infer<typeof ModelProfileSchema>;
