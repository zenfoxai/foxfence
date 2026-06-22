import type { Config } from "../config/schema.ts";
import { ConfigError } from "../config/load.ts";
import type { Detector, DetectorAction, Phase } from "./detector.ts";
import { createSecretsDetector } from "./secrets.ts";
import { createPiiDetector } from "./pii.ts";
import { createToolPolicyDetector } from "./tool-policy.ts";
import { createRemoteDetector } from "./remote.ts";

const DEFAULT_ACTIONS: Record<string, DetectorAction> = {
  secrets: "mask",
  "pii-basic": "flag",
};

/** Spec §5.1 detectors that exist in the design but not in the code yet.
 * Accepted in config (a full spec §7 file must validate) with a warning.
 * `egress-allowlist` is structural: foxfence can only reach configured
 * upstreams by construction. */
const NOT_YET_IMPLEMENTED = new Set(["prompt-injection", "egress-allowlist"]);

const FACTORIES: Record<string, (action: DetectorAction) => Detector> = {
  secrets: createSecretsDetector,
  "pii-basic": createPiiDetector,
};

export interface DetectorSetup {
  detectors: Detector[];
  warnings: string[];
}

export function buildDetectors(config: Config): DetectorSetup {
  const overrides = config.security?.detectors ?? {};
  const warnings: string[] = [];

  const detectors: Detector[] = [];

  for (const [name, entry] of Object.entries(overrides)) {
    if (name === "tool-policy") {
      // Easy mistake: the tool policy lives in its own block, not the
      // detectors map. Fail loudly rather than silently ignore the policy.
      throw new ConfigError(
        'configure the tool policy under "security.tool_policy", not "security.detectors.tool-policy"',
      );
    }
    // Any entry with a `remote:` URL becomes an external classifier (§5.2) —
    // this is also how `prompt-injection` is enabled in deployment.
    if (entry.remote) {
      if (entry.action === "off") continue;
      const action = entry.action === "block" ? "block" : "flag";
      detectors.push(
        createRemoteDetector(name, {
          url: entry.remote,
          action,
          phases: (entry.phases as Phase[] | undefined) ?? ["request"],
          roles: entry.roles as string[] | undefined,
          timeoutMs: (entry.timeout_ms as number | undefined) ?? 2000,
          threshold: (entry.threshold as number | undefined) ?? 0.5,
        }),
      );
      continue;
    }
    if (NOT_YET_IMPLEMENTED.has(name)) {
      warnings.push(
        `detector "${name}" has no built-in implementation yet — add a \`remote:\` classifier URL to enable it`,
      );
    } else if (!(name in FACTORIES)) {
      // A typo'd detector name must never silently weaken the pipeline.
      throw new ConfigError(`unknown detector "${name}" in security.detectors`);
    }
  }

  for (const [name, factory] of Object.entries(FACTORIES)) {
    const action = overrides[name]?.action ?? DEFAULT_ACTIONS[name] ?? "flag";
    if (action === "off") continue;
    detectors.push(factory(action));
  }

  if (config.security?.tool_policy) {
    // compileToolPolicy validates every pattern, so a bad regex/glob is a
    // startup error, not a per-request surprise.
    detectors.push(createToolPolicyDetector(config.security.tool_policy));
  }

  return { detectors, warnings };
}
