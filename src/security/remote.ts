import type { Detector, DetectorInput, Phase, RequestContext, Verdict } from "./detector.ts";

/**
 * Remote detector (§5.2): POSTs a text segment to an external classifier and
 * maps the reply to a verdict. The heavy detection model (LLM Guard,
 * OpenGuardrails, an in-house classifier) lives behind a small HTTP server so
 * the foxfence core stays tiny; this is opt-in per `detectors.<name>.remote`.
 *
 * Wire contract (put a thin adapter in front of your classifier to match it):
 *   POST <url>  { "input": "<text>", "detector": "<name>",
 *                 "phase": "request|response|tool_call", "location": "..." }
 *   200 reply, either:
 *     { "action": "pass|flag|block", "reason"?: "...", "userMessage"?: "..." }
 *       — the service decides outright; or
 *     { "flagged": true|false, "score"?: 0..1, "reason"?: "..." }
 *       — a binary/score classifier; foxfence applies the CONFIGURED action
 *         when flagged (or when score >= threshold).
 *
 * Egress note (§10): the URL is operator-declared config, so it is part of the
 * deliberately-declared egress surface — no undeclared network calls. A failed
 * or timed-out call throws, so the pipeline's fail-closed `on_detector_error`
 * policy governs the outcome (it is never silently treated as "pass").
 */
export interface RemoteDetectorConfig {
  url: string;
  /** Consequence when the classifier flags (the service may override). */
  action: "flag" | "block";
  phases: Phase[];
  /** Only inspect segments from these message roles; undefined = all roles. */
  roles?: string[];
  timeoutMs: number;
  threshold: number;
}

function reasonOf(name: string, data: Record<string, unknown>): string {
  const detail = typeof data.reason === "string" ? data.reason : "flagged by remote classifier";
  const score = typeof data.score === "number" ? ` (score ${data.score})` : "";
  return `${name}: ${detail}${score}`;
}

export function mapRemoteResponse(
  name: string,
  data: Record<string, unknown>,
  cfg: RemoteDetectorConfig,
): Verdict {
  const usableAction = data.action === "pass" || data.action === "flag" || data.action === "block";

  // An unrecognized reply shape (no action/flagged/score) is a contract
  // violation — treat it as fail-closed (throw → on_detector_error governs),
  // never as a silent "clean", or a misconfigured classifier would disable
  // detection without anyone noticing.
  if (!usableAction && typeof data.flagged !== "boolean" && typeof data.score !== "number") {
    throw new Error(`remote detector "${name}" reply has no recognized verdict (action/flagged/score)`);
  }

  // 1. The service can decide outright.
  if (data.action === "pass") return { action: "pass" };
  if (data.action === "flag") return { action: "flag", reason: reasonOf(name, data) };
  if (data.action === "block") {
    return {
      action: "block",
      reason: reasonOf(name, data),
      userMessage: typeof data.userMessage === "string" ? data.userMessage : undefined,
    };
  }

  // 2. Binary / score classifier → apply the configured consequence.
  const flagged =
    data.flagged === true || (typeof data.score === "number" && data.score >= cfg.threshold);
  if (!flagged) return { action: "pass" };

  const reason = reasonOf(name, data);
  return cfg.action === "block"
    ? { action: "block", reason, userMessage: typeof data.userMessage === "string" ? data.userMessage : undefined }
    : { action: "flag", reason };
}

export function createRemoteDetector(name: string, cfg: RemoteDetectorConfig): Detector {
  return {
    name,
    phases: cfg.phases,
    async inspect(input: DetectorInput, phase: Phase, _ctx: RequestContext): Promise<Verdict> {
      if (cfg.roles && input.role !== undefined && !cfg.roles.includes(input.role)) {
        return { action: "pass" };
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
      let res: Response;
      try {
        res = await fetch(cfg.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ input: input.text, detector: name, phase, location: input.location }),
          signal: controller.signal,
        });
      } catch (e) {
        const reason = controller.signal.aborted ? `timed out after ${cfg.timeoutMs}ms` : e instanceof Error ? e.message : String(e);
        throw new Error(`remote detector "${name}" request failed: ${reason}`);
      } finally {
        clearTimeout(timer);
      }

      if (!res.ok) throw new Error(`remote detector "${name}" returned HTTP ${res.status}`);
      let data: unknown;
      try {
        data = await res.json();
      } catch {
        throw new Error(`remote detector "${name}" returned a non-JSON response`);
      }
      if (data === null || typeof data !== "object") {
        throw new Error(`remote detector "${name}" returned a non-object response`);
      }
      return mapRemoteResponse(name, data as Record<string, unknown>, cfg);
    },
  };
}
