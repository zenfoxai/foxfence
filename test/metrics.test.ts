/** Prometheus metrics (§9): the registry rendering and the opt-in endpoint. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Metrics } from "../src/metrics.ts";
import type { AuditRecord } from "../src/audit.ts";
import { createServer } from "../src/server.ts";
import { ConfigSchema } from "../src/config/schema.ts";
import { startFakeUpstream, type FakeUpstream } from "./helpers/fake-upstream.ts";

function rec(over: Partial<AuditRecord> = {}): AuditRecord {
  return {
    ts: "t",
    id: "i",
    model: "m",
    upstream: "u",
    upstream_model: "real",
    stream: false,
    status: 200,
    blocked: false,
    verdicts: [],
    masked: 0,
    restored: 0,
    latency_ms: { total: 10, upstream: 7 },
    ...over,
  };
}

describe("Metrics.render", () => {
  test("counts requests, blocks, repairs, and verdicts per label", () => {
    const m = new Metrics();
    m.record(rec());
    m.record(rec({ blocked: true }));
    m.record(rec({ verdicts: [{ detector: "secrets", action: "mask", location: "x" }] }) as AuditRecord);
    m.record({ ...rec(), shim: { repairs: 2, strategy: "json-prompted" } } as AuditRecord);

    const out = m.render();
    expect(out).toContain('foxfence_requests_total{model="m"} 4');
    expect(out).toContain('foxfence_blocked_total{model="m"} 1');
    expect(out).toContain('foxfence_repairs_total{model="m"} 2');
    expect(out).toContain('foxfence_detector_verdicts_total{action="mask",detector="secrets"} 1');
  });

  test("overhead histogram has buckets, sum, and count", () => {
    const m = new Metrics();
    m.record(rec({ latency_ms: { total: 12, upstream: 9 } })); // overhead 3
    m.record(rec({ latency_ms: { total: 100, upstream: 10 } })); // overhead 90
    const out = m.render();
    expect(out).toContain("# TYPE foxfence_overhead_ms histogram");
    expect(out).toContain('foxfence_overhead_ms_bucket{le="5"} 1'); // the 3ms one
    expect(out).toContain('foxfence_overhead_ms_bucket{le="+Inf"} 2');
    expect(out).toContain("foxfence_overhead_ms_sum 93");
    expect(out).toContain("foxfence_overhead_ms_count 2");
  });
});

describe("the /metrics endpoint", () => {
  let upstream: FakeUpstream;
  beforeAll(() => {
    upstream = startFakeUpstream();
  });
  afterAll(() => upstream.stop());

  function server(metricsEnabled: boolean) {
    const config = ConfigSchema.parse({
      listen: "127.0.0.1:0",
      upstreams: [{ name: "u", base_url: upstream.baseUrl }],
      models: [{ expose: "m", upstream: "u", model: "real" }],
      ...(metricsEnabled ? { metrics: { enabled: true } } : {}),
    });
    return createServer(config);
  }

  test("404 when metrics are disabled (default)", async () => {
    const s = server(false);
    try {
      const res = await fetch(`http://127.0.0.1:${s.port}/metrics`);
      expect(res.status).toBe(404);
    } finally {
      s.stop(true);
    }
  });

  test("enabled: a request shows up in the scrape, no auth required", async () => {
    const s = server(true);
    try {
      await fetch(`http://127.0.0.1:${s.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
      });
      const res = await fetch(`http://127.0.0.1:${s.port}/metrics`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/plain");
      const body = await res.text();
      expect(body).toContain('foxfence_requests_total{model="m"} 1');
    } finally {
      s.stop(true);
    }
  });
});
