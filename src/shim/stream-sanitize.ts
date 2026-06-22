import { findSecrets } from "../security/secrets.ts";

/**
 * Safety-preserving streaming text sanitizer (§6.5 / §10). It lets text stream
 * to the agent token-by-token while keeping the same guarantees the buffered
 * path gives: new secrets in model output are redacted, and mask & restore
 * placeholders are restored.
 *
 * The hard part is not emitting a *prefix* of a secret before the whole secret
 * has been seen. The rule: redact complete secrets in the buffer, then hold
 * back (a) any trailing run of "secret-alphabet" characters — a token that
 * might still be growing into a secret or a placeholder — and (b) an
 * unterminated PEM block. Everything before that boundary is settled and safe
 * to emit; placeholders are restored only on the emitted slice so a restored
 * value can never be re-redacted.
 */

// Characters that appear inside the secrets we detect (keys, tokens, JWTs,
// and our __fox_secret_N__ placeholders). A trailing run of these may still be
// forming, so it is held until a boundary char arrives. This alone is NOT
// enough for secrets that can contain other characters mid-token (notably a
// connection-string password) — those are caught by the danger-prefix hold.
const SECRET_CHAR = /[A-Za-z0-9_\-/+=:.@~]/;

// Distinctive signatures that begin a secret. A region from one of these to the
// end of the buffer with no terminator (whitespace/quote/angle bracket) yet may
// still be growing into a secret whose body contains characters outside
// SECRET_CHAR (e.g. a DB password), so it is held until a boundary arrives and
// findSecrets can redact the complete token.
const DANGER_START =
  /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?|mssql):\/\/|AKIA|ASIA|gh[opusr]_|github_pat_|xox[abprs]|AIza|[sr]k_(?:live|test)|sk-|eyJ/g;
const TERMINATOR = /[\s"'<>]/;

const PEM_BEGIN_WORD = "-----BEGIN";

// DoS backstop: never hold more than this many unemitted bytes.
const MAX_HOLD = 64 * 1024;

function redactSecrets(text: string): string {
  let out = text;
  for (const m of findSecrets(text)) {
    out = out.replaceAll(m.value, `[REDACTED:${m.kind}]`);
  }
  return out;
}

/** Index where the trailing run of secret-alphabet chars begins (== length if
 * the last char is a boundary). That run is held back as possibly-incomplete. */
function trailingRunStart(s: string): number {
  let i = s.length;
  while (i > 0 && SECRET_CHAR.test(s[i - 1]!)) i--;
  return i;
}

/** Index of the earliest secret-signature in the buffer that has no terminator
 * after it yet (so the token is still arriving), or -1. Holds e.g. a
 * connection string whose password contains characters the trailing-run
 * holdback can't see. */
function dangerHoldStart(s: string): number {
  DANGER_START.lastIndex = 0;
  for (const m of s.matchAll(DANGER_START)) {
    if (!TERMINATOR.test(s.slice(m.index + m[0].length))) return m.index;
  }
  return -1;
}

const PEM_FULL = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/;

/** Index from which to hold back a PEM block, or -1. A PEM marker contains
 * spaces and newlines, so neither the trailing-run nor the danger-prefix
 * holdback can see it whole. We hold from "-----BEGIN" until the END marker is
 * complete AND there is at least one character after it — only then is the full
 * block guaranteed to land in the emittable slice for redaction (otherwise the
 * trailing-run boundary could split the END marker and leak the body). A
 * partial "-----B…" suffix that could grow into a header is held too. */
function pemHoldStart(s: string): number {
  const begin = s.lastIndexOf(PEM_BEGIN_WORD);
  if (begin !== -1) {
    const m = PEM_FULL.exec(s.slice(begin));
    if (m && begin + m.index + m[0].length < s.length) return -1; // complete & settled
    return begin; // still forming, or complete-but-at-buffer-end
  }
  // tail that is a prefix of "-----BEGIN" (the marker is still arriving)
  for (let k = Math.min(s.length, PEM_BEGIN_WORD.length - 1); k >= 1; k--) {
    if (PEM_BEGIN_WORD.startsWith(s.slice(s.length - k))) return s.length - k;
  }
  return -1;
}

export class StreamSanitizer {
  private buffer = "";

  /**
   * @param maskTable placeholder → original, for mask & restore.
   * @param redactNewSecrets redact new secrets in model output (matches the
   *   buffered path: on when the secrets detector is active). Restore always
   *   runs when the mask table is non-empty.
   */
  constructor(
    private readonly maskTable: Map<string, string>,
    private readonly redactNewSecrets = true,
  ) {}

  private restore(text: string): string {
    if (this.maskTable.size === 0) return text;
    let out = text;
    for (const [placeholder, original] of this.maskTable) {
      if (out.includes(placeholder)) out = out.replaceAll(placeholder, original);
    }
    return out;
  }

  private maybeRedact(text: string): string {
    return this.redactNewSecrets ? redactSecrets(text) : text;
  }

  /** Nothing to restore and nothing to redact → a transparent passthrough
   * with no holdback latency. */
  private get passthrough(): boolean {
    return this.maskTable.size === 0 && !this.redactNewSecrets;
  }

  /** Feed an upstream text fragment; returns text that is settled and safe to
   * emit now (possibly empty). */
  push(fragment: string): string {
    if (this.passthrough) return fragment;
    this.buffer += fragment;

    // Compute the hold boundary on the RAW buffer: hold back any tail that
    // might still be forming into a secret (a trailing alphabet run, an
    // unterminated danger-prefix like a connection string, or a forming PEM).
    // Crucially, redact AFTER — only the settled emittable slice — so a
    // secret's valid shorter prefix can't be redacted before it's complete.
    let bound = trailingRunStart(this.buffer);
    const danger = dangerHoldStart(this.buffer);
    if (danger !== -1) bound = Math.min(bound, danger);
    const pem = pemHoldStart(this.buffer);
    if (pem !== -1) bound = Math.min(bound, pem);

    // DoS backstop: never hold more than MAX_HOLD (a real secret is far
    // shorter than this; a held token this large is pathological).
    if (this.buffer.length - bound > MAX_HOLD) bound = this.buffer.length - MAX_HOLD;

    if (bound <= 0) return "";
    const slice = this.buffer.slice(0, bound);
    this.buffer = this.buffer.slice(bound);
    // Redact complete secrets in the settled slice, THEN restore placeholders
    // (so a restored value is never re-redacted, and is never held in-buffer).
    return this.restore(this.maybeRedact(slice));
  }

  /** Flush the remaining held text at end of stream. */
  flush(): string {
    if (this.passthrough) return "";
    const out = this.restore(this.maybeRedact(this.buffer));
    this.buffer = "";
    return out;
  }
}
