import type {
  AiGatewayService,
  InvokeTextOpts,
} from "../../ai/core/gateway/ai-gateway.service";
import { type Db } from "../../../db/drizzle.module";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import type { AiUsageMeta } from "../../ai/core/gateway/ai-gateway.types";
import { throwOnAiFailure } from "../../ai/core/services/gateway-result.util";

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
