import type { ModelProfile, ModelRoute, Upstream } from "../config/schema.ts";
import { callUpstream, UpstreamError } from "../upstream/client.ts";
import type { ModelCapabilities, ToolShimStrategy } from "./strategy.ts";
import { createNativeStrategy } from "./native.ts";
import { createJsonPromptedStrategy, type JsonPromptedOptions } from "./json-prompted.ts";
import { createConstrainedStrategy, type ConstrainedMode } from "./constrained.ts";
import { createReactStrategy } from "./react.ts";

/** Capability detection (§6.1): a canonical mini tool-call request sent once
 * per (upstream, model), classified native / weak / none, memoized in memory
 * for the process lifetime. This cache is reconstructible, not business
 * state (§2 principle 1). */

const PROBE_TOOL = {
  type: "function",
  function: {
    name: "fox_ping",
    description: "Connectivity check. Echoes the value back.",
    parameters: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    },
  },
};

const PROBE_MESSAGES = [
  { role: "user", content: 'Call the fox_ping tool with value "pong".' },
];

/** How many native-strategy parse failures downgrade a model (§6.1 runtime
 * fallback). */
const DOWNGRADE_THRESHOLD = 2;

function classify(body: Record<string, unknown>): ModelCapabilities["toolCalling"] {
  const message = (body.choices as Array<Record<string, unknown>> | undefined)?.[0]?.message as
    | Record<string, unknown>
    | undefined;
  if (!message || !Array.isArray(message.tool_calls) || message.tool_calls.length === 0) {
    return "none";
  }
  const call = message.tool_calls[0] as Record<string, unknown>;
  const fn = (call?.function ?? {}) as Record<string, unknown>;
  if (fn.name !== "fox_ping") return "weak";
  try {
    const args = typeof fn.arguments === "string" ? JSON.parse(fn.arguments) : fn.arguments;
    if (args !== null && typeof args === "object" && typeof (args as Record<string, unknown>).value === "string") {
      return "native";
    }
    return "weak";
  } catch {
    return "weak";
  }
}

export class CapabilityStore {
  private cache = new Map<string, ModelCapabilities>();
  private inflight = new Map<string, Promise<ModelCapabilities>>();
  private failures = new Map<string, number>();

  private key(route: ModelRoute, upstream: Upstream): string {
    return `${upstream.name}/${route.model}`;
  }

  peek(route: ModelRoute, upstream: Upstream): ModelCapabilities | undefined {
    return this.cache.get(this.key(route, upstream));
  }

  /** Probes lazily with single-flight: concurrent first requests share one
   * probe. Network errors are NOT cached — the next request re-probes. */
  async resolve(route: ModelRoute, upstream: Upstream): Promise<ModelCapabilities> {
    const key = this.key(route, upstream);
    const cached = this.cache.get(key);
    if (cached) return cached;
    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.probe(route, upstream).then(
        (caps) => {
          this.cache.set(key, caps);
          this.inflight.delete(key);
          return caps;
        },
        (e) => {
          this.inflight.delete(key);
          throw e;
        },
      );
      this.inflight.set(key, pending);
    }
    return pending;
  }

  private async probe(route: ModelRoute, upstream: Upstream): Promise<ModelCapabilities> {
    const base = {
      messages: PROBE_MESSAGES,
      tools: [PROBE_TOOL],
      temperature: 0,
      max_tokens: 200,
      stream: false,
    };
    // forcing the tool maximizes signal; some servers reject object
    // tool_choice, so fall back to a plain request once.
    let response = await callUpstream(
      { ...base, tool_choice: { type: "function", function: { name: "fox_ping" } } },
      route,
      upstream,
    );
    if (response.status >= 400 && response.status < 500) {
      response = await callUpstream(base, route, upstream);
    }
    let toolCalling: ModelCapabilities["toolCalling"] = "none";
    if (response.ok) {
      try {
        toolCalling = classify((await response.json()) as Record<string, unknown>);
      } catch {
        toolCalling = "none";
      }
    } else if (response.status >= 500) {
      throw new UpstreamError(upstream.name, `probe failed with HTTP ${response.status}`);
    }
    return {
      toolCalling,
      parallelToolCalls: false, // not probed yet; profiles will refine this
      jsonMode: "none",
      source: "probe",
    };
  }

  /** Runtime fallback (§6.1): repeated parse failures on a native-classified
   * model downgrade it to `weak`, which routes to json-prompted. */
  noteParseFailure(route: ModelRoute, upstream: Upstream): void {
    const key = this.key(route, upstream);
    const count = (this.failures.get(key) ?? 0) + 1;
    this.failures.set(key, count);
    const caps = this.cache.get(key);
    if (count >= DOWNGRADE_THRESHOLD && caps?.toolCalling === "native") {
      this.cache.set(key, { ...caps, toolCalling: "weak", source: "runtime-downgrade" });
      console.warn(
        `foxfence: model ${key} downgraded native → json-prompted after ${count} parse failures`,
      );
    }
  }
}

export interface StrategyChoice {
  strategy: ToolShimStrategy;
  capabilities: ModelCapabilities | null;
}

/** Picks the strategy for a tools request (§6.1/§6.2). `shim` pins; `auto`
 * probes (unless probing is off, which assumes native passthrough — the
 * transparent default). */
export async function chooseStrategy(
  route: ModelRoute,
  upstream: Upstream,
  store: CapabilityStore,
): Promise<StrategyChoice> {
  const profile = route.profile && typeof route.profile === "object" ? (route.profile as ModelProfile) : undefined;
  const jpOpts: JsonPromptedOptions = {
    noSystemRole: (profile?.chatTemplateQuirks ?? []).includes("no-system-role"),
  };
  const constrainedMode = upstream.constrained as ConstrainedMode | undefined;

  const native = () => createNativeStrategy();
  const jsonPrompted = () => createJsonPromptedStrategy(jpOpts);
  const react = () => createReactStrategy(jpOpts);
  // Use constrained when the upstream declares a mechanism; otherwise degrade
  // to json-prompted rather than sending a constraint field the server can't
  // honour. Config validation normally prevents a constrained pin without a
  // mechanism, so this is defense-in-depth (and the §6.2 preference: prefer
  // constrained over json-prompted whenever available).
  const constrained = () => (constrainedMode ? createConstrainedStrategy(constrainedMode, jpOpts) : jsonPrompted());
  const nonNative = constrained;

  const caps = (
    toolCalling: ModelCapabilities["toolCalling"],
    source: ModelCapabilities["source"],
  ): ModelCapabilities => ({ toolCalling, parallelToolCalls: false, jsonMode: "none", source });

  // 1. Explicit route pin (highest precedence).
  const shim = (route.shim as string | undefined) ?? "auto";
  if (shim === "native") return { strategy: native(), capabilities: caps("native", "pinned") };
  if (shim === "json-prompted") return { strategy: jsonPrompted(), capabilities: caps("none", "pinned") };
  if (shim === "constrained") return { strategy: constrained(), capabilities: caps("none", "pinned") };
  if (shim === "react") return { strategy: react(), capabilities: caps("none", "pinned") };

  // 2. Profile pin.
  if (profile?.pinStrategy === "native") return { strategy: native(), capabilities: caps("native", "profile") };
  if (profile?.pinStrategy === "json-prompted") return { strategy: jsonPrompted(), capabilities: caps("none", "profile") };
  if (profile?.pinStrategy === "constrained") return { strategy: constrained(), capabilities: caps("none", "profile") };
  if (profile?.pinStrategy === "react") return { strategy: react(), capabilities: caps("none", "profile") };

  // 3. Profile-declared capabilities override the probe.
  const declared = profile?.capabilities?.toolCalling;
  if (declared) {
    return declared === "native"
      ? { strategy: native(), capabilities: caps("native", "profile") }
      : { strategy: nonNative(), capabilities: caps(declared, "profile") };
  }

  // 4. probe: off → assume native passthrough (transparent default).
  if ((route.probe as string | undefined) === "off") {
    const cached = store.peek(route, upstream);
    if (!cached) return { strategy: native(), capabilities: caps("native", "assumed") };
    return { strategy: cached.toolCalling === "native" ? native() : nonNative(), capabilities: cached };
  }

  // 5. Probe.
  const probed = await store.resolve(route, upstream);
  return { strategy: probed.toolCalling === "native" ? native() : nonNative(), capabilities: probed };
}
