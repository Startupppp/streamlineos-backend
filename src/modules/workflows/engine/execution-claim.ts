import { and, eq, inArray } from "drizzle-orm";
import { type Db } from "../../../db/drizzle.module";
import { workflowExecutions } from "../../../db/schema";
import { runInNewTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";

export interface ClaimedExecution {
  id: string;
  orgId: string;
  workflowVersionId: string;
  triggerData: Record<string, unknown> | null;
  context: Record<string, unknown> | null;
  triggeredBy: string | null;
}

// The claim is the status transition itself — `pending|waiting -> running` only succeeds for one
// caller, so two concurrent sweeps cannot double-run the same execution and no lock column is
// needed. A cancel racing the claim wins because `cancelled` no longer matches the predicate.
export async function claimExecution(
  db: Db,
  orgId: string,
  executionId: string,
): Promise<ClaimedExecution | null> {
  return runInNewTenantTransaction(db, orgId, async (tx) => {
    const [claimed] = await tx
      .update(workflowExecutions)
      .set({ status: "running", startedAt: new Date() })
      .where(
        and(
          eq(workflowExecutions.id, executionId),
          eq(workflowExecutions.orgId, orgId),
          inArray(workflowExecutions.status, ["pending", "waiting"]),
        ),
      )
      .returning({
        id: workflowExecutions.id,
        orgId: workflowExecutions.orgId,
        workflowVersionId: workflowExecutions.workflowVersionId,
        triggerData: workflowExecutions.triggerData,
        context: workflowExecutions.context,
        triggeredBy: workflowExecutions.triggeredBy,
      });
    return claimed ?? null;
  });
}
