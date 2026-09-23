import { Inject, Injectable } from "@nestjs/common";
import { and, count, desc, eq, lt, or, type SQL } from "drizzle-orm";
import { projectApprovals } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { pendingApprovalsForActorCondition } from "./build-inbox-count.service";

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

export function approvalInboxKeyset(
  cursorId: number | null,
  cursorAt: string | null,
): SQL | undefined {
  if (cursorId === null) return undefined;
  if (cursorAt === null) return lt(projectApprovals.id, cursorId);
  const at = new Date(cursorAt);
  return or(
    lt(projectApprovals.createdAt, at),
    and(eq(projectApprovals.createdAt, at), lt(projectApprovals.id, cursorId)),
  );
}

@Injectable()
export class BuildApprovalsInboxService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async getInboxPage(
    orgId: string,
    _userId: string,
    membershipId: number | null,
    limit: number,
    cursor: number | null,
    cursorAt: string | null = null,
  ): Promise<ApprovalInboxRow[]> {
    if (membershipId === null) return [];
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
          pendingApprovalsForActorCondition(orgId, membershipId),
          approvalInboxKeyset(cursor, cursorAt),
        ),
      )
      .orderBy(desc(projectApprovals.createdAt), desc(projectApprovals.id))
      .limit(limit);

    return rows;
  }

  async countPending(
    orgId: string,
    membershipId: number | null,
  ): Promise<number> {
    if (membershipId === null) return 0;
    const rows = await this.db
      .select({ cnt: count() })
      .from(projectApprovals)
      .where(pendingApprovalsForActorCondition(orgId, membershipId));
    return Number(rows[0]?.cnt ?? 0);
  }
}
