import { SetMetadata } from "@nestjs/common";

export const NO_TENANT_TRANSACTION = "no_tenant_transaction";

/**
 * Opts a handler out of the request-scoped tenant transaction.
 *
 * Required for streaming (SSE) and any handler that stays open long enough to
 * pin a pooled connection. Such a handler MUST wrap its own database work in
 * `runInTenantTransaction(db, fn, { orgId })`, or its queries will be denied
 * once RLS policies are enabled.
 */
export const NoTenantTransaction = () => SetMetadata(NO_TENANT_TRANSACTION, true);
