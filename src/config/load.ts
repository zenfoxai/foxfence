import { ConfigSchema, type Config } from "./schema.ts";

const ENV_VAR = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Recursively substitutes ${VAR} in every string value. Missing vars are a
 * hard error: a config that silently resolves to an empty API key is worse
 * than a refusal to start. */
export function substituteEnv(node: unknown, env: Record<string, string | undefined> = process.env): unknown {
  if (typeof node === "string") {
    return node.replace(ENV_VAR, (_, name: string) => {
      const value = env[name];
      if (value === undefined) {
        throw new ConfigError(`environment variable ${name} is not set (referenced in config)`);
      }
      return value;
    });
  }
  if (Array.isArray(node)) return node.map((item) => substituteEnv(item, env));
  if (node !== null && typeof node === "object") {
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, substituteEnv(v, env)]));
  }
  return node;
}

export class ConfigError extends Error {}

export function parseConfig(yamlText: string, env?: Record<string, string | undefined>): Config {
  let raw: unknown;
  try {
    raw = Bun.YAML.parse(yamlText);
  } catch (e) {
    throw new ConfigError(`invalid YAML: ${e instanceof Error ? e.message : String(e)}`);
  }
  const substituted = substituteEnv(raw, env);
  const parsed = ConfigSchema.safeParse(substituted);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new ConfigError(`invalid config:\n${details}`);
  }
  return parsed.data;
}

export async function loadConfig(path: string): Promise<Config> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new ConfigError(`config file not found: ${path}`);
  }
  return parseConfig(await file.text());
}
