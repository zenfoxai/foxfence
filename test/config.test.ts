import { describe, expect, test } from "bun:test";
import { parseConfig, substituteEnv, ConfigError } from "../src/config/load.ts";

const MINIMAL = `
upstreams:
  - name: ollama
    base_url: http://localhost:11434/v1
models:
  - expose: my-model
    upstream: ollama
    model: qwen2.5:7b-instruct
`;

describe("parseConfig", () => {
  test("minimal config gets defaults", () => {
    const cfg = parseConfig(MINIMAL);
    expect(cfg.listen).toBe("127.0.0.1:4100");
    expect(cfg.api_keys).toEqual([]);
    expect(cfg.models[0]?.expose).toBe("my-model");
  });

  test("accepts and ignores future-phase fields (full spec §7 config)", () => {
    const cfg = parseConfig(`
listen: 127.0.0.1:4100
upstreams:
  - name: ollama
    base_url: http://localhost:11434/v1
models:
  - expose: qwen-tools
    upstream: ollama
    model: qwen2.5:7b-instruct
    shim: auto
    probe: lazy
    repair: { max_attempts: 2 }
security:
  on_detector_error: block
audit:
  file: ./foxfence-audit.jsonl
`);
    expect(cfg.models[0]?.expose).toBe("qwen-tools");
  });

  test("rejects a model referencing an unknown upstream", () => {
    expect(() =>
      parseConfig(MINIMAL.replace("upstream: ollama\n", "upstream: nope\n")),
    ).toThrow(/unknown upstream "nope"/);
  });

  test("rejects duplicate exposed names", () => {
    const dup = MINIMAL + `
  - expose: my-model
    upstream: ollama
    model: other
`;
    expect(() => parseConfig(dup)).toThrow(/duplicate exposed model name/);
  });

  test("rejects invalid YAML and empty configs", () => {
    expect(() => parseConfig(": not yaml :")).toThrow(ConfigError);
    expect(() => parseConfig("listen: 1.2.3.4:80")).toThrow(ConfigError);
  });
});

describe("substituteEnv", () => {
  test("substitutes ${VAR} recursively", () => {
    const out = substituteEnv(
      { key: "Bearer ${TOKEN}", nested: ["${TOKEN}", "plain"] },
      { TOKEN: "abc" },
    );
    expect(out).toEqual({ key: "Bearer abc", nested: ["abc", "plain"] });
  });

  test("missing variable is a hard error", () => {
    expect(() => substituteEnv("${DOES_NOT_EXIST_XYZ}", {})).toThrow(
      /DOES_NOT_EXIST_XYZ is not set/,
    );
  });

  test("non-strings pass through untouched", () => {
    expect(substituteEnv({ n: 42, b: true, x: null }, {})).toEqual({ n: 42, b: true, x: null });
  });
});
