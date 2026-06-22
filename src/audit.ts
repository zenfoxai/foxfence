import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Local JSONL audit trail (§9). No telemetry: this file is the only place
 * foxfence records anything, and only if configured. Content is excluded
 * unless `include_content: true`. */

export interface AuditVerdict {
  detector: string;
  action: string;
  location: string;
  detail?: string;
}

export interface AuditRecord {
  ts: string;
  id: string;
  model: string;
  upstream: string;
  upstream_model: string;
  stream: boolean;
  status: number;
  blocked: boolean;
  verdicts: AuditVerdict[];
  masked: number;
  restored: number;
  latency_ms: { total: number; upstream: number };
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  content?: { request: unknown; response: unknown };
}

export class AuditLog {
  private constructor(private readonly path: string) {}

  static open(path: string): AuditLog {
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch (e) {
      throw new Error(
        `cannot create audit directory for "${path}": ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    return new AuditLog(path);
  }

  write(record: AuditRecord): void {
    try {
      // Synchronous append keeps ordering trivial; revisit with a buffered
      // writer if it ever shows up in the <5ms overhead budget (§9).
      appendFileSync(this.path, JSON.stringify(record) + "\n");
    } catch (e) {
      console.error(`foxfence: audit write failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
