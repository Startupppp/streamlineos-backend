import { Global, Module } from "@nestjs/common";
import { IdempotencyInterceptor } from "./idempotency.interceptor";
import { COMMAND_FENCE_STORE, DrizzleCommandFenceStore } from "./command-fence-store";

/**
 * Provides the {@link IdempotencyInterceptor} and its {@link DrizzleCommandFenceStore} so
 * `@Idempotent(...)` can be referenced as a method-level interceptor from any controller.
 * DRIZZLE is resolved from the global DrizzleModule.
 *
 * In e2e tests, override COMMAND_FENCE_STORE with an {@link InMemoryCommandFenceStore} so
 * the fence works correctly without a real database.
 */
@Global()
@Module({
  providers: [
    { provide: COMMAND_FENCE_STORE, useClass: DrizzleCommandFenceStore },
    IdempotencyInterceptor,
  ],
  exports: [COMMAND_FENCE_STORE, IdempotencyInterceptor],
})
export class IdempotencyModule {}
