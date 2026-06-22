import type { Detector, RequestContext, ToolCallInput, Verdict } from "./detector.ts";
import { ConfigError } from "../config/load.ts";

/** Tool-call policy engine (§5.3) — the safety differentiator. It runs on
 * tool calls AFTER parsing/repair (Pipeline OUT), so it enforces policy even
 * for models with no native tool calling, which a text-level firewall can't
 * do cleanly.
 *
 * IMPORTANT — defense in depth, not a sandbox. Argument matching is a
 * best-effort pattern check: a glob like "*rm -rf*" will miss "rm -r -f",
 * "rm  -rf", base64-wrapped payloads, etc. Treat it as one layer plus an
 * audit signal, never as the sole guard on a dangerous tool. Use
 * `default: deny` allowlisting for anything that actually matters.
 *
 * Matching specifics:
 * - Globs are case-INSENSITIVE and anchored full-match; `/regex/flags` form
 *   respects its own flags. A negation prefix `!` inverts the result.
 * - Object/array arguments are matched against their JSON.stringify form
 *   (e.g. an array is `["a","b"]`, no spaces), so design patterns for that
 *   shape, not the human-readable one.
 * - Operator-supplied `/regex/` is trusted config but is also run against
 *   model-influenced argument text; a compile-time guard rejects the classic
 *   catastrophic-backtracking shape (x+)+, but it is not a full ReDoS
 *   analyzer. Prefer globs unless you need a regex. */

export interface ToolPolicyRule {
  tool: string;
  args?: Record<string, string>;
  action: "allow" | "block" | "flag";
  message?: string;
}

export interface ToolPolicyConfig {
  default: "allow" | "deny";
  rules: ToolPolicyRule[];
}

export type PolicyDecision =
  | { action: "allow" }
  | { action: "flag"; reason: string }
  | { action: "block"; reason: string; message?: string };

/** A pattern with optional `!` negation and `/regex/flags` form; otherwise a
 * glob (`*` any run, `?` any char). Globs are anchored full-match and
 * compiled with the dotAll flag so `*` spans newlines — without it,
 * `*rm -rf*` would fail to match "ls\nrm -rf /", a trivial bypass. */
export interface Matcher {
  test(value: string): boolean;
  readonly source: string;
}

export function globToRegExpSource(glob: string): string {
  let out = "";
  for (const ch of glob) {
    if (ch === "*") out += ".*";
    else if (ch === "?") out += ".";
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return out;
}

/** Strict `/expr/flags` form: leading slash, a closing slash, and only valid
 * regex flag chars after it. This keeps slash-bearing globs (e.g.
 * "/api/admin/*", a literal path glob) from being mis-read as regex — only a
 * genuine /…/ wrapper is treated as a regex. */
const REGEX_FORM = /^\/(.*)\/([dgimsuy]*)$/;

/** The classic catastrophic-backtracking shape: a quantifier applied to a
 * group that itself ends in a quantifier, e.g. (a+)+, (a*)*, (.*)+. Not a
 * complete ReDoS analyzer — a cheap guard against the common footgun. */
const NESTED_QUANTIFIER = /[*+]\)[*+?]/;

export function compileMatcher(pattern: string): Matcher {
  let negate = false;
  let body = pattern;
  if (body.startsWith("!")) {
    negate = true;
    body = body.slice(1);
  }

  let re: RegExp;
  const regexForm = body.startsWith("/") ? REGEX_FORM.exec(body) : null;
  if (regexForm) {
    const expr = regexForm[1]!;
    const flags = regexForm[2]!;
    if (NESTED_QUANTIFIER.test(expr)) {
      throw new ConfigError(
        `tool policy regex "${pattern}" has a nested quantifier (e.g. "(x+)+") that risks ` +
          `catastrophic backtracking; rewrite it or use a glob`,
      );
    }
    try {
      re = new RegExp(expr, flags);
    } catch (e) {
      throw new ConfigError(
        `invalid regex in tool policy pattern "${pattern}": ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  } else {
    // dotAll so `*` spans newlines (no "ls\nrm -rf /" bypass); case-insensitive
    // so casing can't evade a rule (e.g. "EXEC" vs "exec").
    re = new RegExp(`^${globToRegExpSource(body)}$`, "si");
  }

  return {
    source: pattern,
    test: (value: string) => (negate ? !re.test(value) : re.test(value)),
  };
}

function argToString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

interface CompiledRule {
  raw: ToolPolicyRule;
  name: Matcher;
  args: Array<{ key: string; matcher: Matcher }>;
}

export interface CompiledToolPolicy {
  default: "allow" | "deny";
  evaluate(name: string, args: Record<string, unknown>): PolicyDecision;
}

/** Compiles the policy once (at server start) so per-request evaluation is
 * just regex tests, keeping within the <5 ms overhead budget (§9). Invalid
 * patterns throw a ConfigError here rather than failing per request. */
export function compileToolPolicy(config: ToolPolicyConfig): CompiledToolPolicy {
  const compiled: CompiledRule[] = config.rules.map((rule) => ({
    raw: rule,
    name: compileMatcher(rule.tool),
    args: Object.entries(rule.args ?? {}).map(([key, pattern]) => ({
      key,
      matcher: compileMatcher(pattern),
    })),
  }));

  return {
    default: config.default,
    evaluate(name, args): PolicyDecision {
      // Stringify each argument at most once per call, not once per rule.
      const asString = new Map<string, string>();
      const argString = (key: string): string => {
        let s = asString.get(key);
        if (s === undefined) {
          s = argToString(args[key]);
          asString.set(key, s);
        }
        return s;
      };

      for (const rule of compiled) {
        if (!rule.name.test(name)) continue;
        // A rule's arg clause matches only if every named arg is present AND
        // matches. `Object.hasOwn` (not `in`) so inherited keys like
        // "toString"/"constructor" can't spuriously satisfy a rule. A missing
        // arg means the rule does not apply — you cannot violate a URL
        // allowlist if you passed no URL; absence is governed by
        // `default: deny`, not by arg rules.
        let argsOk = true;
        const matchedArgs: string[] = [];
        for (const { key, matcher } of rule.args) {
          if (!Object.hasOwn(args, key) || !matcher.test(argString(key))) {
            argsOk = false;
            break;
          }
          matchedArgs.push(`${key}~"${matcher.source}"`);
        }
        if (!argsOk) continue;

        const where =
          rule.args.length > 0 ? ` (matched ${matchedArgs.join(", ")})` : "";
        if (rule.raw.action === "allow") return { action: "allow" };
        if (rule.raw.action === "flag") {
          return { action: "flag", reason: `tool "${name}" matched flag rule${where}` };
        }
        return {
          action: "block",
          reason: `tool "${name}" blocked by policy rule${where}`,
          message: rule.raw.message,
        };
      }

      if (this.default === "deny") {
        return {
          action: "block",
          reason: `tool "${name}" is not permitted (default deny)`,
        };
      }
      return { action: "allow" };
    },
  };
}

export function createToolPolicyDetector(config: ToolPolicyConfig): Detector {
  const policy = compileToolPolicy(config);

  // A negated arg pattern under `default: allow` is a classic false-sense-of-
  // security trap: a call that simply omits the argument matches no rule and
  // is allowed. Warn rather than silently let it through.
  if (config.default === "allow") {
    for (const rule of config.rules) {
      if (rule.action === "allow") continue;
      const hasNegatedArg = Object.values(rule.args ?? {}).some((p) => p.startsWith("!"));
      if (hasNegatedArg) {
        console.warn(
          `foxfence: tool-policy rule for "${rule.tool}" uses a negated arg pattern under ` +
            `default:allow — a call that omits that argument will NOT be caught; consider default:deny`,
        );
      }
    }
  }

  return {
    name: "tool-policy",
    phases: ["tool_call"],
    inspectToolCall(input: ToolCallInput, _ctx: RequestContext): Verdict {
      const decision = policy.evaluate(input.name, input.arguments);
      if (decision.action === "allow") return { action: "pass" };
      if (decision.action === "flag") return { action: "flag", reason: decision.reason };
      return { action: "block", reason: decision.reason, userMessage: decision.message };
    },
  };
}
