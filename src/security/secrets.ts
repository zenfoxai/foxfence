import type {
  Detector,
  DetectorAction,
  DetectorInput,
  Phase,
  Replacement,
  RequestContext,
  Verdict,
} from "./detector.ts";

/** High-precision secret patterns (§5.1). Precision over recall: a false
 * positive silently corrupts a working request, a false negative only means
 * we are no worse than no proxy at all. */
interface SecretPattern {
  kind: string;
  regex: RegExp;
  /** Minimum Shannon entropy (bits/char) over the match, for patterns whose
   * shape alone is too generic. */
  minEntropy?: number;
}

const PATTERNS: SecretPattern[] = [
  { kind: "aws-access-key-id", regex: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { kind: "github-token", regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/g },
  { kind: "github-token", regex: /\bgithub_pat_[A-Za-z0-9_]{50,}\b/g },
  { kind: "slack-token", regex: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: "gcp-api-key", regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: "stripe-key", regex: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  // Covers OpenAI sk-..., sk-proj-..., Anthropic sk-ant-...; the shape is
  // generic enough to require an entropy gate.
  { kind: "api-key", regex: /\bsk-[A-Za-z0-9_-]{32,}\b/g, minEntropy: 3.0 },
  {
    kind: "private-key",
    regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    kind: "connection-string",
    regex:
      /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?|mssql):\/\/[^\s:/@]+:[^\s@/]+@[^\s"'<>]+/g,
  },
  { kind: "jwt", regex: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
];

/** Shannon entropy in bits per character. */
export function entropyBitsPerChar(s: string): number {
  if (s.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

export interface SecretMatch {
  kind: string;
  value: string;
}

export function findSecrets(text: string): SecretMatch[] {
  const matches: SecretMatch[] = [];
  for (const pattern of PATTERNS) {
    pattern.regex.lastIndex = 0;
    for (const m of text.matchAll(pattern.regex)) {
      const value = m[0];
      if (pattern.minEntropy !== undefined && entropyBitsPerChar(value) < pattern.minEntropy) {
        continue;
      }
      matches.push({ kind: pattern.kind, value });
    }
  }
  // Longest first so e.g. a connection string containing something key-shaped
  // is masked as a whole before the inner match is considered.
  matches.sort((a, b) => b.value.length - a.value.length);
  const kept: SecretMatch[] = [];
  for (const m of matches) {
    if (!kept.some((k) => k.value.includes(m.value))) kept.push(m);
  }
  return kept;
}

export function createSecretsDetector(action: DetectorAction): Detector {
  return {
    name: "secrets",
    phases: ["request", "response"],
    inspect(input: DetectorInput, phase: Phase, ctx: RequestContext): Verdict {
      const found = findSecrets(input.text);
      if (found.length === 0) return { action: "pass" };
      const summary = found.map((f) => f.kind).join(", ");

      if (action === "block") {
        return {
          action: "block",
          reason: `secret detected (${summary}) in ${input.location}`,
          userMessage: "Request blocked by foxfence: it contains material that looks like a secret.",
        };
      }
      if (action === "flag") {
        return { action: "flag", reason: `secret detected (${summary}) in ${input.location}` };
      }
      // mask: on the request we mask & restore; on the response a *new*
      // secret produced by the model is redacted permanently.
      const replacements: Replacement[] = found.map((f) => ({
        original: f.value,
        placeholder: phase === "request" ? ctx.nextPlaceholder() : `[REDACTED:${f.kind}]`,
        restore: phase === "request",
        kind: f.kind,
      }));
      return { action: "mask", replacements };
    },
  };
}
