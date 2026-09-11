import { applyDecorators, SetMetadata } from "@nestjs/common";
import { IDEMPOTENCY_COMMAND, IDEMPOTENCY_OPTIONAL } from "./idempotency.constants";

export interface IdempotentOptions {
  /**
   * Whether the `Idempotency-Key` header must be present.
   *
   * Defaults to true, which is the right default for a command whose replay is
   * a correctness problem — a payment, a posting, a state transition. Left
   * required, a caller who omits the header is answered 400 rather than allowed
   * to execute unfenced.
   *
   * `false` is for a high-frequency write where retry safety is a service to
   * the caller rather than an invariant of the system: honour the key when one
   * arrives, and do not turn an existing integration into a 400 because it
   * never sent one. Nothing else changes — a request that *does* carry a key
   * gets the full contract, replay and all.
   */
  required?: boolean;
}

/**
 * Marks a mutating handler as a sensitive command that must be replay-safe. Callers supply an
 * `Idempotency-Key` header; the first request executes and its response is stored, a completed
 * retry replays that response, a same-key different-request retry is rejected (422), and a
 * concurrent in-flight duplicate is rejected (409).
 *
 * "Same request" means the command name, the route params and the body together
 * — so one key reused across two resources under the same route (stopping two
 * different timers, posting two different invoices) is a 422 rather than a
 * replay of the first. See `IdempotencyInterceptor.hashRequest`.
 *
 * With `{ required: false }` the header becomes optional: present, it is
 * honoured exactly as above; absent, the handler runs unfenced. See
 * `IdempotentOptions.required` for when that is the honest choice.
 *
 * The `IdempotencyInterceptor` is registered as a global APP_INTERCEPTOR in `app.module.ts`
 * (after `ZodValidationInterceptor` and `TenantContextInterceptor`) so it is test-overridable
 * via `overrideProvider`, claims the fence only after validation, and runs inside the tenant
 * transaction context. This decorator only sets the metadata that the global interceptor
 * reads. It must NOT also attach the interceptor with `UseInterceptors`: the fence would be
 * claimed twice per request, and the second claim would find the first in flight and 409.
 */
export function Idempotent(
  commandName: string,
  options: IdempotentOptions = {},
): MethodDecorator & ClassDecorator {
  return applyDecorators(
    SetMetadata(IDEMPOTENCY_COMMAND, commandName),
    SetMetadata(IDEMPOTENCY_OPTIONAL, options.required === false),
  );
}
