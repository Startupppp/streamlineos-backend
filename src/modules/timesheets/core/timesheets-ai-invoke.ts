import type {
  AiGatewayService,
  InvokeTextOpts,
} from "../../ai/core/gateway/ai-gateway.service";
import { type Db } from "../../../db/drizzle.module";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import type { AiUsageMeta } from "../../ai/core/gateway/ai-gateway.types";
import { throwOnAiFailure } from "../../ai/core/services/gateway-result.util";

/**
 * Runs `read` in its own tenant transaction that commits before returning, so
 * the pooled connection is back before the caller talks to the provider.
 * `db` is the tenant-aware proxy, so the delegate services inside `read`
 * pick up this transaction's GUC with no signature change. If some caller does
 * have an ambient tenant context, `runInTenantTransaction` reuses it rather
 * than nesting.
 */
export function readEvidence<T>(db: Db, orgId: string, read: () => Promise<T>): Promise<T> {
  return runInTenantTransaction(db, read, { orgId });
}

export async function invokeAiText(
  gateway: AiGatewayService,
  options: InvokeTextOpts,
): Promise<{ text: string; aiUsage?: AiUsageMeta }> {
  const result = await gateway.invokeTextWithUsage(options);
  if (!result.ok) return throwOnAiFailure(result);
  return { text: result.data, aiUsage: result.aiUsage };
}
