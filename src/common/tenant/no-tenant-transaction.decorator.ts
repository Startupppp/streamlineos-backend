import { SetMetadata } from "@nestjs/common";

export const NO_TENANT_TRANSACTION = "no_tenant_transaction";

/**
 * Opts a handler out of the request-scoped tenant transaction.
 *
 * Required for streaming (SSE), identity-scoped organization discovery, and
 * any handler that intentionally crosses from one tenant to another. Such a
 * handler MUST wrap every database operation in `withIdentity`,
 * `runInTenantTransaction`, or another explicit RLS context.
 */
export const NoTenantTransaction = () => SetMetadata(NO_TENANT_TRANSACTION, true);
