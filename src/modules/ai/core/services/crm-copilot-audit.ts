import { auditLogs } from "../../../../db/schema";
import type { Db } from "../../../../db/drizzle.module";
import { runInTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";

export async function auditAiAction(
  db: Db,
  orgId: string,
  userId: string,
  action: string,
  targetType: string,
  targetId: string,
): Promise<void> {
  await runInTenantTransaction(db, async (tx) => {
    await tx.insert(auditLogs).values({
      action,
      userId,
      orgId,
      targetId,
      targetType,
      metadata: { source: "crm-copilot" },
    });
  }, { orgId });
}
