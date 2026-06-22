import type { Detector, DetectorAction, DetectorInput, Verdict } from "./detector.ts";

/** Basic PII detection (§5.1): emails, phone numbers, payment cards.
 * Default action is `flag` — these patterns are inherently fuzzier than the
 * secrets set, so they inform the audit trail rather than mutate traffic. */

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
// International-ish numbers with separators; deliberately conservative.
const PHONE = /(?:\+\d{1,3}[ .-]?)?\(?\d{2,4}\)?[ .-]\d{3,4}[ .-]\d{2,4}(?:[ .-]\d{2,4})?\b/g;
const CARD = /\b(?:\d[ -]?){12,18}\d\b/g;

export function luhnValid(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

export function findPii(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  const bump = (kind: string) => counts.set(kind, (counts.get(kind) ?? 0) + 1);

  EMAIL.lastIndex = 0;
  for (const _ of text.matchAll(EMAIL)) bump("email");

  CARD.lastIndex = 0;
  const cardSpans: Array<[number, number]> = [];
  for (const m of text.matchAll(CARD)) {
    if (luhnValid(m[0].replace(/[ -]/g, ""))) {
      bump("card");
      cardSpans.push([m.index, m.index + m[0].length]);
    }
  }

  PHONE.lastIndex = 0;
  for (const m of text.matchAll(PHONE)) {
    // A card number with separators also looks like a phone number.
    const inCard = cardSpans.some(([s, e]) => m.index >= s && m.index < e);
    if (!inCard) bump("phone");
  }
  return counts;
}

export function createPiiDetector(action: DetectorAction): Detector {
  return {
    name: "pii-basic",
    phases: ["request"],
    inspect(input: DetectorInput): Verdict {
      const counts = findPii(input.text);
      if (counts.size === 0) return { action: "pass" };
      const summary = [...counts.entries()].map(([k, n]) => `${k}×${n}`).join(", ");
      if (action === "block") {
        return {
          action: "block",
          reason: `PII detected (${summary}) in ${input.location}`,
          userMessage: "Request blocked by foxfence: it contains personal data.",
        };
      }
      // pii-basic never masks (too fuzzy); anything except block is a flag.
      return { action: "flag", reason: `PII detected (${summary}) in ${input.location}` };
    },
  };
}
