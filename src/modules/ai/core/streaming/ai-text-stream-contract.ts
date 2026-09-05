import { ApiOkResponse } from "@nestjs/swagger";

export function ApiAiTextStream(description: string): MethodDecorator {
  return ApiOkResponse({
    description,
    content: { "text/plain": { schema: { type: "string" } } },
  });
}
