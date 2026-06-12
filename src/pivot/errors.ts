/** Errors in the standard OpenAI wire format (§8): every error body is
 * { error: { message, type, param, code } }. */

export function openAIError(
  status: number,
  message: string,
  type: string,
  code: string | null = null,
  param: string | null = null,
): Response {
  return Response.json({ error: { message, type, param, code } }, { status });
}

export const errors = {
  invalidApiKey: () =>
    openAIError(401, "Incorrect API key provided.", "invalid_request_error", "invalid_api_key"),
  modelNotFound: (model: string) =>
    openAIError(
      404,
      `The model \`${model}\` does not exist or is not exposed by this foxfence instance.`,
      "invalid_request_error",
      "model_not_found",
      "model",
    ),
  invalidJson: (detail: string) =>
    openAIError(400, `Invalid JSON body: ${detail}`, "invalid_request_error", null),
  invalidRequest: (message: string, param: string | null = null) =>
    openAIError(400, message, "invalid_request_error", null, param),
  notFound: (path: string) =>
    openAIError(404, `Unknown request URL: ${path}`, "invalid_request_error", "unknown_url"),
  methodNotAllowed: (method: string, path: string) =>
    openAIError(405, `Not allowed to ${method} on ${path}`, "invalid_request_error", null),
  upstreamUnreachable: (upstream: string, detail: string) =>
    openAIError(
      502,
      `Failed to reach upstream "${upstream}": ${detail}`,
      "upstream_error",
      "upstream_unreachable",
    ),
};
