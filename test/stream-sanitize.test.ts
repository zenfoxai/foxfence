/** StreamSanitizer (§6.5) — the safety crux of incremental streaming. The
 * load-bearing invariant: however the input is chunked, the cumulative emitted
 * text is always a prefix of the fully-sanitized result, so a prefix of a
 * secret is never emitted before the secret is redacted. */

import { describe, expect, test } from "bun:test";
import { StreamSanitizer } from "../src/shim/stream-sanitize.ts";

const AWS = "AKIAIOSFODNN7EXAMPLE";
const GH = "ghp_abcDEF123456789012345678901234567890";
const PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\nabcdef\n-----END RSA PRIVATE KEY-----";
// password contains "!" — a character OUTSIDE the trailing-run alphabet
const CONN = "postgres://admin:p!ssw0rd@db.internal:5432/prod";
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";

function oneShot(input: string, mask = new Map<string, string>()): string {
  const s = new StreamSanitizer(mask);
  return s.push(input) + s.flush();
}

/** Streams `input` in fixed-size chunks, returning every cumulative-output
 * snapshot plus the final total. */
function streamChunks(input: string, size: number, mask = new Map<string, string>()) {
  const s = new StreamSanitizer(mask);
  const snapshots: string[] = [];
  let total = "";
  for (let i = 0; i < input.length; i += size) {
    total += s.push(input.slice(i, i + size));
    snapshots.push(total);
  }
  total += s.flush();
  snapshots.push(total);
  return { total, snapshots };
}

/** Asserts the prefix invariant across every chunk size for an input. */
function assertChunkingSafe(input: string, mask = new Map<string, string>()) {
  const expected = oneShot(input, mask);
  for (let size = 1; size <= input.length; size++) {
    const { total, snapshots } = streamChunks(input, size, new Map(mask));
    expect(total).toBe(expected);
    for (const snap of snapshots) {
      expect(expected.startsWith(snap)).toBe(true); // never emit something not in the final
    }
  }
  return expected;
}

describe("plain text", () => {
  test("passes through unchanged regardless of chunking", () => {
    const out = assertChunkingSafe("The quick brown fox jumps over the lazy dog.");
    expect(out).toBe("The quick brown fox jumps over the lazy dog.");
  });
});

describe("secret redaction never leaks a prefix", () => {
  test("AWS key embedded in text, every chunk boundary", () => {
    const out = assertChunkingSafe(`here is the key ${AWS} keep it safe`);
    expect(out).toContain("[REDACTED:aws-access-key-id]");
    expect(out).not.toContain(AWS);
  });

  test("GitHub token at the very end of the stream", () => {
    const out = assertChunkingSafe(`your token: ${GH}`);
    expect(out).toContain("[REDACTED:github-token]");
    expect(out).not.toContain(GH);
  });

  test("two secrets back to back", () => {
    const out = assertChunkingSafe(`${AWS} and ${GH}`);
    expect(out).not.toContain(AWS);
    expect(out).not.toContain(GH);
    expect(out).toContain("[REDACTED:aws-access-key-id]");
    expect(out).toContain("[REDACTED:github-token]");
  });

  test("a multi-line PEM private key is never partially emitted", () => {
    const out = assertChunkingSafe(`config:\n${PEM}\ndone`);
    expect(out).toContain("[REDACTED:private-key]");
    expect(out).not.toContain("MIIEpAIBAAKCAQEA");
    expect(out).not.toContain("BEGIN RSA PRIVATE KEY");
  });

  test("a connection string with a non-alphabet password char never leaks", () => {
    // regression: the password's "!" breaks the trailing-run alphabet, so the
    // danger-prefix hold (from "postgres://") must keep it held until redaction
    const out = assertChunkingSafe(`db is ${CONN} ok`);
    expect(out).toContain("[REDACTED:connection-string]");
    expect(out).not.toContain("admin:p");
    expect(out).not.toContain("ssw0rd");
  });

  test("a JWT spanning dots is never partially emitted", () => {
    const out = assertChunkingSafe(`bearer ${JWT} end`);
    expect(out).toContain("[REDACTED:jwt]");
    expect(out).not.toContain("eyJzdWIi");
  });
});

describe("mask & restore", () => {
  test("a placeholder split across chunks is restored, never partially shown", () => {
    const mask = new Map([["__fox_secret_1__", AWS]]);
    const expected = assertChunkingSafe("your key __fox_secret_1__ is restored", mask);
    expect(expected).toBe(`your key ${AWS} is restored`);
  });

  test("a restored original is NOT re-redacted", () => {
    // the user's own secret, masked on the way in, comes back restored
    const mask = new Map([["__fox_secret_1__", AWS]]);
    const out = oneShot("here: __fox_secret_1__ end", mask);
    expect(out).toBe(`here: ${AWS} end`);
    expect(out).not.toContain("[REDACTED");
  });

  test("restore and new-secret redaction coexist in one stream", () => {
    const mask = new Map([["__fox_secret_1__", AWS]]);
    const out = assertChunkingSafe(`mine __fox_secret_1__ and new ${GH} here`, mask);
    expect(out).toContain(AWS); // restored
    expect(out).toContain("[REDACTED:github-token]"); // new one redacted
    expect(out).not.toContain(GH);
  });
});

describe("flush", () => {
  test("trailing held token is emitted on flush", () => {
    const s = new StreamSanitizer(new Map());
    const mid = s.push("ends with a word");
    const end = s.flush();
    expect(mid + end).toBe("ends with a word");
  });
});
