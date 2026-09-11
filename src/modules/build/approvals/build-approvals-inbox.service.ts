import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, inArray, isNull, lt } from "drizzle-orm";
import { projectApprovals } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";

export type ApprovalInboxRow = {
  id: number;
  projectId: number;
  title: string;
  status: string;
  entityType: string;
  entityId: number;
  dueAt: Date | null;
  createdAt: Date;
};

@Injectable()
export class BuildApprovalsInboxService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async getInboxPage(
    orgId: string,
    _userId: string,
    membershipId: number | null,
    limit: number,
    cursor: number | null,
  ): Promise<ApprovalInboxRow[]> {
    if (membershipId === null) return [];
    const actorPredicate = eq(projectApprovals.approverMembershipId, membershipId);
    const rows = await this.db
      .select({
        id: projectApprovals.id,
        projectId: projectApprovals.projectId,
        title: projectApprovals.title,
        status: projectApprovals.status,
        entityType: projectApprovals.entityType,
        entityId: projectApprovals.entityId,
        dueAt: projectApprovals.dueAt,
        createdAt: projectApprovals.createdAt,
      })
      .from(projectApprovals)
      .where(
        and(
          eq(projectApprovals.orgId, orgId),
          actorPredicate,
          inArray(projectApprovals.status, ["pending", "escalated"]),
          isNull(projectApprovals.deletedAt),
          cursor !== null ? lt(projectApprovals.id, cursor) : undefined,
        ),
      )
      .orderBy(desc(projectApprovals.id))
      .limit(limit);

    return rows;
  }
}
