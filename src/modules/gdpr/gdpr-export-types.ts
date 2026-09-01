import type { AnyColumn } from "drizzle-orm";
import type { Table } from "drizzle-orm/table";

export const BATCH_SIZE = 200;
export type ExportCursor = string | number;

export type SubjectScopedTable = Table & {
  id: AnyColumn;
  orgId: AnyColumn;
};

export interface SubjectScopedAdapter {
  source: string;
  table: SubjectScopedTable;
  userColumn: AnyColumn;
}

export interface MembershipScopedAdapter {
  source: string;
  table: SubjectScopedTable;
  membershipColumn: AnyColumn;
}

export interface EmploymentScopedAdapter {
  source: string;
  table: SubjectScopedTable;
  employmentColumn: AnyColumn;
}

export const REDACTED_EXPORT_COLUMNS = new Set([
  "token",
  "tokenPrefix",
  "tokenEncrypted",
  "tokenHash",
  "accessCodeHash",
  "otpCodeHash",
  "signingTokenHash",
  "codeHash",
  "keyHash",
  "auth",
  "p256dh",
  "configEncrypted",
  "composioConnectedAccountId",
  "endpoint",
  "reviewerUserId",
  "reviewerMembershipId",
  "approverId",
  "approverMembershipId",
  "assigneeId",
  "assigneeMembershipId",
  "managerId",
  "managerMembershipId",
  "hrRepId",
  "hrRepMembershipId",
  "managerApproverId",
  "managerApproverMembershipId",
  "financeApproverId",
  "financeApproverMembershipId",
  "coveringEmployeeId",
  "coveringEmployeeMembershipId",
  "createdBy",
  "createdByMembershipId",
  "updatedByMembershipId",
  "submittedBy",
  "calibratedBy",
  "approvedBy",
  "approvedByMembershipId",
  "decidedBy",
  "decidedByMembershipId",
  "verifiedBy",
  "overriddenBy",
  "uploadedBy",
  "lockedByMembershipId",
]);

export interface ExportSection {
  rows: unknown[];
  truncated: boolean;
}

export function countExportRows(
  ...sections: Array<Pick<ExportSection, "rows">>
): number {
  return sections.reduce((count, section) => count + section.rows.length, 0);
}

export async function drainExportPages<C extends ExportCursor, T extends { id: C }>(
  fetcher: (afterId: C | undefined) => Promise<T[]>,
  batchSize = BATCH_SIZE,
): Promise<ExportSection> {
  const rows: unknown[] = [];
  let afterId: C | undefined;
  for (;;) {
    const batch = await fetcher(afterId);
    if (!batch.length) break;
    rows.push(...batch);
    const nextCursor = batch[batch.length - 1]!.id;
    if (afterId !== undefined && nextCursor === afterId)
      throw new Error("GDPR export cursor did not advance");
    afterId = nextCursor;
    if (batch.length < batchSize) break;
  }
  return { rows, truncated: false };
}
