import { ApiOkResponse } from "@nestjs/swagger";
import { AI_RESULT_STREAM_CONTENT_TYPE } from "./ai-result-stream";

export function ApiAiResultStream(): MethodDecorator {
  return ApiOkResponse({
    description: "Newline-delimited JSON: text frames contain text; one terminal result frame contains the completed DTO in data, including aiUsage; a terminal error frame contains a safe message. EOF without result is incomplete. Authentication and validation errors use the normal JSON error envelope before streaming starts.",
    content: {
      [AI_RESULT_STREAM_CONTENT_TYPE]: { schema: { type: "string", format: "ndjson" } },
    },
  });
}
