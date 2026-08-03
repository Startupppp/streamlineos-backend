import { applyDecorators, SetMetadata, UseInterceptors } from "@nestjs/common";
import { IDEMPOTENCY_COMMAND } from "./idempotency.constants";
import { IdempotencyInterceptor } from "./idempotency.interceptor";

/**
 * Marks a mutating handler as a sensitive command that must be replay-safe. Callers supply an
 * `Idempotency-Key` header; the first request executes and its response is stored, a completed
 * retry replays that response, a same-key different-body request is rejected (422), and a
 * concurrent in-flight duplicate is rejected (409).
 */
export function Idempotent(commandName: string): MethodDecorator & ClassDecorator {
  return applyDecorators(
    SetMetadata(IDEMPOTENCY_COMMAND, commandName),
    UseInterceptors(IdempotencyInterceptor),
  );
}
