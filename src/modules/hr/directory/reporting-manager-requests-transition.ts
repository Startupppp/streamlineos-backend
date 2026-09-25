import { and, eq, inArray } from "drizzle-orm";
import type { DbOrTx } from "../../../common/rbac/access-invalidate";
import { hrReportingManagerRequests, type ReportingManagerRequestStatus } from "../../../db/schema";
import { ReportingLineException } from "../../directory/reporting-line-errors";
import { REPORTING_LINE_ERROR_CODES as CODES } from "../../directory/reporting-line.types";
import type { RequestRow } from "./reporting-manager-requests-read";

/** Compare-and-set on status, so two reviewers deciding at once cannot both win. */
export async function transitionRequest(
  tx: DbOrTx,
  orgId: string,
  row: RequestRow,
  from: readonly ReportingManagerRequestStatus[],
  set: Partial<typeof hrReportingManagerRequests.$inferInsert>,
): Promise<void> {
  if (!from.includes(row.status))
    throw new ReportingLineException(CODES.REQUEST_INVALID_TRANSITION, `A ${row.status.toLowerCase()} request cannot be changed this way.`);
  const [updated] = await tx
    .update(hrReportingManagerRequests)
    .set({ ...set, updatedAt: new Date() })
    .where(
      and(
        eq(hrReportingManagerRequests.orgId, orgId),
        eq(hrReportingManagerRequests.id, row.id),
        inArray(hrReportingManagerRequests.status, [...from]),
      ),
    )
    .returning({ id: hrReportingManagerRequests.id });
  if (!updated) throw new ReportingLineException(CODES.REQUEST_INVALID_TRANSITION, "This request changed while you were looking at it. Reload it.");
}
