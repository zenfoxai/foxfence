import { ConfigSchema } from "../src/config/schema.ts";
import { createServer } from "../src/server.ts";
import { loadCorpus, type EvalCase } from "./corpus.ts";
import { startSimModel } from "./sim-model.ts";
import { scoreCase, aggregate, type CaseScore, type Aggregate } from "./score.ts";

interface Target {
  label: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
}

interface RunRow {
  mode: "direct" | "foxfence";
  scores: CaseScore[];
  agg: Aggregate;
  totalRepairs: number;
}

async function postChat(
  target: Target,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (target.apiKey) headers.authorization = `Bearer ${target.apiKey}`;
  const res = await fetch(`${target.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...payload, model: target.model }),
  });
  return (await res.json()) as Record<string, unknown>;
}

async function runTarget(target: Target, cases: EvalCase[]): Promise<{ scores: CaseScore[]; repairs: number }> {
  const scores: CaseScore[] = [];
  let repairs = 0;
  for (const c of cases) {
    const body = await postChat(target, { messages: c.messages, tools: c.tools });
    scores.push(scoreCase(c, body));
    const shim = (body.foxfence as Record<string, unknown> | undefined)?.shim as
      | Record<string, unknown>
      | undefined;
    if (typeof shim?.repairs === "number") repairs += shim.repairs;
  }
  return { scores, repairs };
}

export interface EvalOptions {
  /** Real OpenAI-compatible endpoint; omit to use the bundled sim model. */
  endpoint?: string;
  model?: string;
  apiKey?: string;
  casesDir?: string;
  /** Force the foxfence shim strategy (auto | native | json-prompted | …). */
  shim?: string;
}

export interface EvalResult {
  rows: RunRow[];
  cases: number;
  modelLabel: string;
}

/** Runs the corpus directly against a model and through foxfence, scoring
 * both. With no endpoint, spins up the bundled simulated weak model. */
export async function runEval(opts: EvalOptions = {}): Promise<EvalResult> {
  const { cases, skipped } = loadCorpus(opts.casesDir);
  if (skipped.length > 0) {
    console.warn(`eval: skipped ${skipped.length} invalid case(s):`);
    for (const s of skipped) console.warn(`  - ${s.id}: ${s.errors.join("; ")}`);
  }
  if (cases.length === 0) throw new Error("no valid eval cases found");

  let sim: ReturnType<typeof startSimModel> | null = null;
  let upstreamBaseUrl: string;
  let upstreamModel: string;
  let directTarget: Target;
  let modelLabel: string;

  if (opts.endpoint) {
    upstreamBaseUrl = opts.endpoint;
    upstreamModel = opts.model ?? "default";
    modelLabel = `${upstreamModel} @ ${opts.endpoint}${opts.shim ? ` (foxfence shim: ${opts.shim})` : ""}`;
    directTarget = { label: "direct", baseUrl: opts.endpoint, model: upstreamModel, apiKey: opts.apiKey };
  } else {
    sim = startSimModel(cases);
    upstreamBaseUrl = sim.baseUrl;
    upstreamModel = "sim-weak";
    modelLabel = "simulated weak model (no native tool calling)";
    directTarget = { label: "direct", baseUrl: sim.baseUrl, model: "sim-weak" };
  }

  const config = ConfigSchema.parse({
    listen: "127.0.0.1:0",
    upstreams: [{ name: "upstream", base_url: upstreamBaseUrl, ...(opts.apiKey ? { api_key: opts.apiKey } : {}) }],
    models: [
      {
        expose: "foxfence-shim",
        upstream: "upstream",
        model: upstreamModel,
        // Force a strategy to measure the capability shim against a model that
        // already does native tools; omit (default auto) for the realistic path.
        ...(opts.shim ? { shim: opts.shim } : {}),
      },
    ],
  });
  const foxfence = createServer(config);
  const foxfenceTarget: Target = {
    label: "foxfence",
    baseUrl: `http://127.0.0.1:${foxfence.port}/v1`,
    model: "foxfence-shim",
  };

  try {
    const direct = await runTarget(directTarget, cases);
    const fox = await runTarget(foxfenceTarget, cases);
    const rows: RunRow[] = [
      { mode: "direct", scores: direct.scores, agg: aggregate(direct.scores), totalRepairs: direct.repairs },
      { mode: "foxfence", scores: fox.scores, agg: aggregate(fox.scores), totalRepairs: fox.repairs },
    ];
    return { rows, cases: cases.length, modelLabel };
  } finally {
    foxfence.stop(true);
    sim?.stop();
  }
}

const pct = (x: number) => `${(x * 100).toFixed(0)}%`;

export function renderTable(result: EvalResult): string {
  const lines: string[] = [];
  lines.push(`Model under test: ${result.modelLabel}`);
  lines.push(`Cases: ${result.cases}`);
  lines.push("");
  lines.push(
    "| mode | valid-call rate | exact-match rate | tool-call cases | no-call cases | loop-broke cases | repairs |",
  );
  lines.push("|---|---|---|---|---|---|---|");
  for (const row of result.rows) {
    const a = row.agg;
    lines.push(
      `| ${row.mode} | ${pct(a.validCallRate)} | ${pct(a.exactMatchRate)} | ` +
        `${pct(a.toolValidRate)} (${a.toolCases}) | ${pct(a.noCallCorrectRate)} (${a.noCallCases}) | ` +
        `${pct(a.loopBrokeRate)} (${a.loopCases}) | ${row.totalRepairs} |`,
    );
  }
  return lines.join("\n");
}

function parseArgs(argv: string[]): EvalOptions & { out?: string; json?: boolean } {
  const opts: EvalOptions & { out?: string; json?: boolean } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--endpoint") opts.endpoint = argv[++i];
    else if (a === "--model") opts.model = argv[++i];
    else if (a === "--key") opts.apiKey = argv[++i];
    else if (a === "--shim") opts.shim = argv[++i];
    else if (a === "--out") opts.out = argv[++i];
    else if (a === "--json") opts.json = true;
  }
  return opts;
}

if (import.meta.main) {
  const opts = parseArgs(process.argv.slice(2));
  const result = await runEval(opts);
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const table = renderTable(result);
    console.log(table);
    if (opts.out) {
      await Bun.write(opts.out, table + "\n");
      console.log(`\nwrote ${opts.out}`);
    }
  }
}
