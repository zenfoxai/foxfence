/** Plugin interfaces for safety detectors (spec §4).
 *
 * Golden rule: pure and stateless. A detector receives one text segment and
 * returns a verdict; it never mutates the request and never keeps state
 * between calls. All per-request state lives in RequestContext.
 *
 * Deviation from the spec draft: `phases` is an array (the spec table itself
 * needs `secrets` on both request and response). */

export type Phase = "request" | "response" | "tool_call";

/** Action a detector is configured to take when it finds something.
 * "off" disables the detector entirely. */
export type DetectorAction = "pass" | "flag" | "mask" | "block" | "off";

export interface DetectorInput {
  /** One text segment of the request or response. */
  text: string;
  /** Where the segment came from, e.g. "messages[2].content". */
  location: string;
  /** The role of the message the segment came from ("user", "tool",
   * "assistant", "system"), when known — lets a detector target e.g.
   * tool-sourced content (§5.1). */
  role?: string;
}

/** A parsed tool call, given to "tool_call"-phase detectors after the shim
 * has decoded and validated it (§5.3). */
export interface ToolCallInput {
  name: string;
  /** Parsed arguments object ({} if the model produced none/invalid JSON). */
  arguments: Record<string, unknown>;
  /** The raw arguments JSON string as it will be returned to the agent. */
  rawArguments: string;
  index: number;
  /** e.g. "choices[0].message.tool_calls[1]". */
  location: string;
}

export interface Replacement {
  /** Kept in memory for the lifetime of the request only. */
  original: string;
  placeholder: string;
  /** Restore the original in the response? (mask & restore) */
  restore: boolean;
  /** What was matched, e.g. "aws-access-key-id" (foxfence extension). */
  kind: string;
}

export type Verdict =
  | { action: "pass" }
  | { action: "block"; reason: string; userMessage?: string }
  | { action: "mask"; replacements: Replacement[] }
  | { action: "flag"; reason: string };

export interface RequestContext {
  id: string;
  exposedModel: string;
  stream: boolean;
  /** placeholder → original, applied on the way out (restore). */
  maskTable: Map<string, string>;
  nextPlaceholder(): string;
}

export interface Detector {
  name: string;
  phases: Phase[];
  /** Text-segment inspection, for "request"/"response" phases. */
  inspect?(input: DetectorInput, phase: Phase, ctx: RequestContext): Verdict | Promise<Verdict>;
  /** Structured tool-call inspection, for the "tool_call" phase. A detector
   * implements whichever methods match the phases it declares. */
  inspectToolCall?(input: ToolCallInput, ctx: RequestContext): Verdict | Promise<Verdict>;
}

export function createContext(exposedModel: string, stream: boolean): RequestContext {
  let counter = 0;
  return {
    id: crypto.randomUUID(),
    exposedModel,
    stream,
    maskTable: new Map(),
    nextPlaceholder: () => `__fox_secret_${++counter}__`,
  };
}
