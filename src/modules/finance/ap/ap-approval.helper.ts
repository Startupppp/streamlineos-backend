import type { Db } from "../../../db/drizzle.module";
import { finApprovalPolicies, finApprovalRequests } from "../../../db/schema";
import { and, eq } from "drizzle-orm";
import type { finApprovalRecordTypeEnum } from "../../../db/schema";

type RecordType = (typeof finApprovalRecordTypeEnum.enumValues)[number];

export interface ApprovalCheckResult {
  needsApproval: boolean;
  policyId: number | null;
  approverUserId: string | null;
}

export async function checkApprovalPolicy(
  db: Db,
  orgId: string,
  recordType: RecordType,
  total: number,
): Promise<ApprovalCheckResult> {
  const policies = await db
    .select({
      id: finApprovalPolicies.id,
      minAmount: finApprovalPolicies.minAmount,
      approverUserId: finApprovalPolicies.approverUserId,
    })
    .from(finApprovalPolicies)
    .where(
      and(
        eq(finApprovalPolicies.orgId, orgId),
        eq(finApprovalPolicies.recordType, recordType),
        eq(finApprovalPolicies.isActive, true),
      ),
    );

  const applicable = policies.find((p) => {
    if (p.minAmount === null) return true;
    return total >= Number(p.minAmount);
  });

  if (!applicable) {
    return { needsApproval: false, policyId: null, approverUserId: null };
  }

  return {
    needsApproval: true,
    policyId: applicable.id,
    approverUserId: applicable.approverUserId ?? null,
  };
}

export async function insertApprovalRequest(
  db: Db,
  orgId: string,
  recordType: RecordType,
  recordId: number,
  requestedBy: string,
  note?: string,
): Promise<number> {
  const [inserted] = await db
    .insert(finApprovalRequests)
    .values({
      orgId,
      recordType,
      recordId,
      status: "PENDING",
      requestedBy,
      note: note ?? null,
    })
    .returning({ id: finApprovalRequests.id });

  if (!inserted) throw new Error("Approval request insert returned no rows");
  return inserted.id;
}

export async function getApprovalRequest(
  db: Db,
  orgId: string,
  recordType: RecordType,
  recordId: number,
) {
  const rows = await db
    .select({
      id: finApprovalRequests.id,
      status: finApprovalRequests.status,
      requestedBy: finApprovalRequests.requestedBy,
    })
    .from(finApprovalRequests)
    .where(
      and(
        eq(finApprovalRequests.orgId, orgId),
        eq(finApprovalRequests.recordType, recordType),
        eq(finApprovalRequests.recordId, recordId),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}
