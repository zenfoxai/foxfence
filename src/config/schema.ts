import { z } from "zod";

export const UpstreamSchema = z.object({
  name: z.string().min(1),
  base_url: z.url(),
  api_key: z.string().optional(),
});

// Fields beyond { expose, upstream, model } (shim, probe, profile, repair…)
// belong to later phases; they are accepted and ignored so a full
// foxfence.yaml from the spec validates today.
export const ModelRouteSchema = z.looseObject({
  expose: z.string().min(1),
  upstream: z.string().min(1),
  model: z.string().min(1),
});

export const ConfigSchema = z
  .looseObject({
    listen: z.string().default("127.0.0.1:4100"),
    api_keys: z.array(z.string().min(1)).default([]),
    upstreams: z.array(UpstreamSchema).min(1),
    models: z.array(ModelRouteSchema).min(1),
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
      if (!upstreamNames.has(m.upstream)) {
        ctx.issues.push({
          code: "custom",
          message: `model "${m.expose}" references unknown upstream "${m.upstream}"`,
          input: m.upstream,
          path: ["models", i, "upstream"],
        });
      }
    });
  });

export type Config = z.infer<typeof ConfigSchema>;
export type Upstream = z.infer<typeof UpstreamSchema>;
export type ModelRoute = z.infer<typeof ModelRouteSchema>;
