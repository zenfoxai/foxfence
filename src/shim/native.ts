import type { DecodeResult, ToolShimStrategy } from "./strategy.ts";
import { getTools } from "./strategy.ts";
import { decodeNativeCalls } from "./json-prompted.ts";

/** `native` strategy (§6.2 #1): the upstream handles tools itself. The shim
 * touches nothing on the way in; on the way out tool calls are still
 * validated against their JSON Schemas (§6.4) so a malformed native call is
 * repaired or rejected, never forwarded. */
export function createNativeStrategy(): ToolShimStrategy {
  return {
    name: "native",

    encode(body) {
      return { ...body, stream: false };
    },

    decode(upstreamBody, original): DecodeResult {
      const message = (upstreamBody.choices as Array<Record<string, unknown>> | undefined)?.[0]
        ?.message as Record<string, unknown> | undefined;

      if (message && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
        return decodeNativeCalls(message, getTools(original));
      }

      // no tool call: acceptable unless the request demanded one
      const choice = original.tool_choice;
      const demanded =
        choice === "required" || (choice !== null && typeof choice === "object");
      if (demanded) {
        return {
          ok: false,
          error: "tool_choice demanded a tool call but the model returned none",
          repairHint: "You must call a tool. Reply with a tool call, not plain text.",
        };
      }
      return {
        ok: true,
        message: {
          role: "assistant",
          content: typeof message?.content === "string" ? message.content : null,
        },
        finishReason: "stop",
      };
    },

    repairTurn(upstreamBody, repairHint) {
      const message = (upstreamBody.choices as Array<Record<string, unknown>> | undefined)?.[0]
        ?.message;
      return [
        (message ?? { role: "assistant", content: "" }) as Record<string, unknown>,
        { role: "user", content: `Your previous reply was invalid: ${repairHint}` },
      ];
    },
  };
}
