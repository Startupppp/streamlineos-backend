import { NotFoundException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { projectApprovals } from "../../../db/schema";
import { type Db } from "../../../db/drizzle.module";

export async function loadApproval(db: Db, orgId: string, projectId: number, approvalId: number) {
  const row = await db.query.projectApprovals.findFirst({
    where: and(
      eq(projectApprovals.id, approvalId),
      eq(projectApprovals.orgId, orgId),
      eq(projectApprovals.projectId, projectId),
      isNull(projectApprovals.deletedAt),
    ),
  });
  if (!row) throw new NotFoundException("Approval not found");
  return row;
}
