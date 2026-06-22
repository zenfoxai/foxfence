import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ModelProfileSchema, type Config, type ModelProfile } from "./schema.ts";
import { ConfigError } from "./load.ts";

/** Loads the community profile registry (§6.1) from a directory of YAML files.
 * Each file is one profile or an array of profiles; every profile must carry a
 * unique `id`. A missing directory yields an empty registry (profiles are
 * optional). */
export function loadProfileRegistry(dir: string): Map<string, ModelProfile> {
  const registry = new Map<string, ModelProfile>();
  if (!existsSync(dir)) return registry;

  for (const file of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort()) {
    let parsed: unknown;
    try {
      parsed = Bun.YAML.parse(readFileSync(join(dir, file), "utf8"));
    } catch (e) {
      throw new ConfigError(`invalid YAML in profile ${file}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    for (const entry of entries) {
      const result = ModelProfileSchema.safeParse(entry);
      if (!result.success) {
        throw new ConfigError(
          `invalid profile in ${file}: ${result.error.issues.map((i) => i.message).join("; ")}`,
        );
      }
      const profile = result.data;
      if (!profile.id) throw new ConfigError(`profile in ${file} is missing an "id"`);
      if (registry.has(profile.id)) throw new ConfigError(`duplicate profile id "${profile.id}"`);
      registry.set(profile.id, profile);
    }
  }
  return registry;
}

/**
 * Resolves each route's `profile` field to a concrete profile object: a string
 * is looked up in the registry, an inline object is used as-is. Returns a map
 * keyed by the exposed model name. Loads the registry only if some route
 * references a profile by id (so the common no-profiles case touches no disk).
 */
export function resolveProfiles(config: Config): Map<string, ModelProfile> {
  const resolved = new Map<string, ModelProfile>();
  const needsRegistry = config.models.some((m) => typeof m.profile === "string");
  const registry = needsRegistry
    ? loadProfileRegistry(config.profiles_dir ?? "./profiles")
    : new Map<string, ModelProfile>();

  for (const route of config.models) {
    if (route.profile === undefined) continue;
    if (typeof route.profile === "string") {
      const found = registry.get(route.profile);
      if (!found) {
        throw new ConfigError(
          `model "${route.expose}" references unknown profile "${route.profile}"` +
            (needsRegistry ? ` (looked in ${config.profiles_dir ?? "./profiles"})` : ""),
        );
      }
      resolved.set(route.expose, found);
    } else {
      resolved.set(route.expose, route.profile);
    }
  }

  // A profile that pins the constrained strategy needs the upstream to declare
  // a mechanism — same rule as `shim: constrained`, but enforced here because a
  // string profile reference is invisible to the parse-time schema check.
  const upstreams = new Map(config.upstreams.map((u) => [u.name, u]));
  for (const route of config.models) {
    if (resolved.get(route.expose)?.pinStrategy !== "constrained") continue;
    if (!upstreams.get(route.upstream)?.constrained) {
      const ref = typeof route.profile === "string" ? `"${route.profile}"` : "(inline)";
      throw new ConfigError(
        `model "${route.expose}" uses profile ${ref} pinning the constrained strategy, but upstream ` +
          `"${route.upstream}" does not declare a \`constrained:\` mechanism (response_format | guided_json)`,
      );
    }
  }
  return resolved;
}
