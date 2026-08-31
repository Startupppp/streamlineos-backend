import { applyDecorators, SetMetadata } from "@nestjs/common";
import { IDEMPOTENCY_COMMAND } from "./idempotency.constants";

/**
 * Marks a mutating handler as a sensitive command that must be replay-safe. Callers supply an
 * `Idempotency-Key` header; the first request executes and its response is stored, a completed
 * retry replays that response, a same-key different-body request is rejected (422), and a
 * concurrent in-flight duplicate is rejected (409).
 *
 * The `IdempotencyInterceptor` is registered as a global APP_INTERCEPTOR in `app.module.ts`
 * (after `TenantContextInterceptor`) so it is test-overridable via `overrideProvider` and
 * always runs inside the tenant transaction context. This decorator only sets the metadata
 * that the global interceptor reads.
 */
export function Idempotent(commandName: string): MethodDecorator & ClassDecorator {
  return applyDecorators(SetMetadata(IDEMPOTENCY_COMMAND, commandName));
}
