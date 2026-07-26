import { Global, Module } from "@nestjs/common";
import { IdempotencyInterceptor } from "./idempotency.interceptor";

/**
 * Provides the singleton {@link IdempotencyInterceptor} so `@Idempotent(...)` can reference it as a
 * method-level interceptor from any controller. DRIZZLE is resolved from the global DrizzleModule.
 */
@Global()
@Module({
  providers: [IdempotencyInterceptor],
  exports: [IdempotencyInterceptor],
})
export class IdempotencyModule {}
