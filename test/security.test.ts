import { describe, expect, test } from "bun:test";
import { findSecrets, entropyBitsPerChar, createSecretsDetector } from "../src/security/secrets.ts";
import { findPii, luhnValid } from "../src/security/pii.ts";
import { createContext } from "../src/security/detector.ts";

describe("findSecrets", () => {
  const cases: Array<[string, string]> = [
    ["aws-access-key-id", "creds: AKIAIOSFODNN7EXAMPLE here"],
    ["github-token", "token ghp_abcDEF123456789012345678901234567890 ok"],
    ["github-token", `pat github_pat_${"a1".repeat(30)} ok`],
    ["slack-token", "xoxb-1234567890-abcdefghij"],
    ["gcp-api-key", "AIzaSyA1bC2dE3fG4hI5jK6lM7nO8pQ9rS0tU1v"],
    ["stripe-key", "sk_live_abcdef1234567890ABCD"],
    ["api-key", "sk-proj-Ab3dEf9hIjK2mNoPqRsTuVwXyZ01234567"],
    ["connection-string", "postgres://admin:hunter2@db.internal:5432/prod"],
    ["jwt", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk"],
  ];
  for (const [kind, text] of cases) {
    test(`detects ${kind}`, () => {
      const found = findSecrets(text);
      expect(found.map((f) => f.kind)).toContain(kind);
    });
  }

  test("detects PEM private key blocks", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----";
    expect(findSecrets(`config:\n${pem}\ndone`)[0]?.kind).toBe("private-key");
  });

  test("entropy gate rejects low-entropy sk- strings", () => {
    expect(findSecrets("sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toEqual([]);
  });

  test("plain text yields nothing", () => {
    expect(findSecrets("Please refactor the login handler and add tests.")).toEqual([]);
  });

  test("overlapping matches keep only the outermost", () => {
    // the connection string is matched as a whole, not also its inner parts
    const found = findSecrets("mongodb+srv://root:s3cret@cluster.example.com/db");
    expect(found).toHaveLength(1);
    expect(found[0]?.kind).toBe("connection-string");
  });
});

describe("entropyBitsPerChar", () => {
  test("uniform string is 0, varied string is high", () => {
    expect(entropyBitsPerChar("aaaa")).toBe(0);
    expect(entropyBitsPerChar("aB3xZ9qLmP0wK5tY")).toBeGreaterThan(3.5);
  });
});

describe("secrets detector verdicts", () => {
  const ctx = () => createContext("m", false);

  test("mask on request phase → restorable placeholders", async () => {
    const verdict = await createSecretsDetector("mask").inspect!(
      { text: "key AKIAIOSFODNN7EXAMPLE", location: "messages[0].content" },
      "request",
      ctx(),
    );
    if (verdict.action !== "mask") throw new Error(`expected mask, got ${verdict.action}`);
    expect(verdict.replacements[0]?.placeholder).toMatch(/^__fox_secret_\d+__$/);
    expect(verdict.replacements[0]?.restore).toBe(true);
  });

  test("mask on response phase → permanent redaction", async () => {
    const verdict = await createSecretsDetector("mask").inspect!(
      { text: "leak AKIAIOSFODNN7EXAMPLE", location: "choices[0].message.content" },
      "response",
      ctx(),
    );
    if (verdict.action !== "mask") throw new Error(`expected mask, got ${verdict.action}`);
    expect(verdict.replacements[0]?.placeholder).toBe("[REDACTED:aws-access-key-id]");
    expect(verdict.replacements[0]?.restore).toBe(false);
  });

  test("block action produces a block verdict with reason", async () => {
    const verdict = await createSecretsDetector("block").inspect!(
      { text: "key AKIAIOSFODNN7EXAMPLE", location: "messages[0].content" },
      "request",
      ctx(),
    );
    expect(verdict.action).toBe("block");
  });
});

describe("findPii", () => {
  test("emails", () => {
    expect(findPii("contact alice@example.com and bob@corp.io").get("email")).toBe(2);
  });

  test("valid card via Luhn, invalid rejected", () => {
    expect(findPii("pay with 4242 4242 4242 4242 please").get("card")).toBe(1);
    expect(findPii("pay with 4242 4242 4242 4243 please").has("card")).toBe(false);
  });

  test("phone numbers", () => {
    expect(findPii("call me at +1 415-555-2671 tomorrow").get("phone")).toBe(1);
  });

  test("a card is not double-counted as a phone", () => {
    const counts = findPii("4242 4242 4242 4242");
    expect(counts.get("card")).toBe(1);
    expect(counts.has("phone")).toBe(false);
  });

  test("code-like text yields nothing", () => {
    expect(findPii("const x = foo(1, 2); // refactor later").size).toBe(0);
  });
});

describe("luhnValid", () => {
  test("known-good and known-bad numbers", () => {
    expect(luhnValid("4242424242424242")).toBe(true);
    expect(luhnValid("4242424242424243")).toBe(false);
    expect(luhnValid("123")).toBe(false);
  });
});
