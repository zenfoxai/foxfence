import type { AuditRecord } from "./audit.ts";

/** Prometheus metrics (§9), opt-in via `metrics.enabled`. Derived from the same
 * data the audit trail records, so the two never disagree. In-memory and
 * reconstructible — like the capability cache, it is not business state. */

const OVERHEAD_BUCKETS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000];

function escapeLabel(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function labelKey(labels: Record<string, string>): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return "";
  return keys.map((k) => `${k}="${escapeLabel(labels[k]!)}"`).join(",");
}

interface Histogram {
  buckets: number[];
  counts: number[]; // count per bucket (non-cumulative), plus +Inf at the end
  sum: number;
  count: number;
}

function newHistogram(buckets: number[]): Histogram {
  return { buckets, counts: new Array(buckets.length + 1).fill(0), sum: 0, count: 0 };
}

export class Metrics {
  private counters = new Map<string, { name: string; labels: string; value: number }>();
  private overhead = newHistogram(OVERHEAD_BUCKETS);
  private upstream = newHistogram(OVERHEAD_BUCKETS);

  private inc(name: string, labels: Record<string, string>, by = 1): void {
    const lk = labelKey(labels);
    const key = `${name}{${lk}}`;
    const cur = this.counters.get(key);
    if (cur) cur.value += by;
    else this.counters.set(key, { name, labels: lk, value: by });
  }

  private observe(h: Histogram, value: number): void {
    h.sum += value;
    h.count += 1;
    let i = 0;
    while (i < h.buckets.length && value > h.buckets[i]!) i++;
    h.counts[i]! += 1;
  }

  /** Records one completed request from its audit record. */
  record(r: AuditRecord): void {
    const model = r.model;
    this.inc("foxfence_requests_total", { model });
    if (r.status >= 500) this.inc("foxfence_upstream_errors_total", { model });
    if (r.blocked) this.inc("foxfence_blocked_total", { model });

    const repairs = (r as { shim?: { repairs?: number } }).shim?.repairs;
    if (typeof repairs === "number" && repairs > 0) {
      this.inc("foxfence_repairs_total", { model }, repairs);
    }
    const strategy = (r as { shim?: { strategy?: string } }).shim?.strategy;
    if (typeof strategy === "string") this.inc("foxfence_shim_strategy_total", { model, strategy });

    for (const v of r.verdicts) {
      this.inc("foxfence_detector_verdicts_total", { detector: v.detector, action: v.action });
    }

    if (typeof r.latency_ms?.total === "number" && typeof r.latency_ms?.upstream === "number") {
      const overhead = Math.max(0, r.latency_ms.total - r.latency_ms.upstream);
      this.observe(this.overhead, overhead);
      this.observe(this.upstream, r.latency_ms.upstream);
    }
  }

  /** Prometheus text exposition (content type text/plain; version=0.0.4). */
  render(): string {
    const lines: string[] = [];
    const byName = new Map<string, Array<{ labels: string; value: number }>>();
    for (const c of this.counters.values()) {
      const arr = byName.get(c.name) ?? [];
      arr.push({ labels: c.labels, value: c.value });
      byName.set(c.name, arr);
    }
    for (const [name, series] of byName) {
      lines.push(`# TYPE ${name} counter`);
      for (const s of series) lines.push(`${name}{${s.labels}} ${s.value}`);
    }

    for (const [name, h] of [
      ["foxfence_overhead_ms", this.overhead] as const,
      ["foxfence_upstream_ms", this.upstream] as const,
    ]) {
      lines.push(`# TYPE ${name} histogram`);
      let cumulative = 0;
      for (let i = 0; i < h.buckets.length; i++) {
        cumulative += h.counts[i]!;
        lines.push(`${name}_bucket{le="${h.buckets[i]}"} ${cumulative}`);
      }
      cumulative += h.counts[h.buckets.length]!;
      lines.push(`${name}_bucket{le="+Inf"} ${cumulative}`);
      lines.push(`${name}_sum ${h.sum}`);
      lines.push(`${name}_count ${h.count}`);
    }

    return lines.join("\n") + "\n";
  }
}
