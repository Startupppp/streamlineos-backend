import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, gt, isNull, or, sql, type SQL } from "drizzle-orm";
import { pendingApprovalsForActorCondition } from "./build-inbox-count.service";
import { projectApprovals, projects } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { assertProjectAccess } from "../core/project-access";
import { loadApproval } from "./approval-lookup";
import type { InboxQuery, ListApprovalsQuery } from "./dto/approvals.schemas";

function listApprovalsKeyset(cursorId: number | undefined, cursorDueAt: Date | undefined): SQL | undefined {
  if (cursorId === undefined) return undefined;
  if (cursorDueAt !== undefined) {
    return or(
      gt(projectApprovals.dueAt, cursorDueAt),
      and(eq(projectApprovals.dueAt, cursorDueAt), gt(projectApprovals.id, cursorId)),
      isNull(projectApprovals.dueAt),
    );
  }
  return and(isNull(projectApprovals.dueAt), gt(projectApprovals.id, cursorId));
}

@Injectable()
export class ApprovalsReadService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
  ) {}

  async getInbox(orgId: string, membershipId: number, query: InboxQuery) {
    return this.db
      .select({
        id: projectApprovals.id,
        projectId: projectApprovals.projectId,
        projectName: projects.name,
        projectKey: projects.key,
        entityType: projectApprovals.entityType,
        entityId: projectApprovals.entityId,
        title: projectApprovals.title,
        status: projectApprovals.status,
        level: projectApprovals.level,
        dueAt: projectApprovals.dueAt,
        requestedById: projectApprovals.requestedById,
        decidedAt: projectApprovals.decidedAt,
      })
      .from(projectApprovals)
      .innerJoin(projects, eq(projects.id, projectApprovals.projectId))
      .where(and(pendingApprovalsForActorCondition(orgId, membershipId), listApprovalsKeyset(query.cursorId, query.cursorDueAt)))
      .orderBy(sql`${projectApprovals.dueAt} ASC NULLS LAST`, asc(projectApprovals.id))
      .limit(100);
  }

  async listApprovals(u: CurrentUserContext, projectId: number, query: ListApprovalsQuery) {
    const { orgId } = u;
    await assertProjectAccess(this.db, this.access, u, projectId);
    return this.db
      .select()
      .from(projectApprovals)
      .where(
        and(
          eq(projectApprovals.orgId, orgId),
          eq(projectApprovals.projectId, projectId),
          isNull(projectApprovals.deletedAt),
          query.status ? eq(projectApprovals.status, query.status) : undefined,
          query.entityType ? eq(projectApprovals.entityType, query.entityType) : undefined,
          listApprovalsKeyset(query.cursorId, query.cursorDueAt),
        ),
      )
      .orderBy(sql`${projectApprovals.dueAt} ASC NULLS LAST`, asc(projectApprovals.id))
      .limit(100);
  }

  async getApproval(u: CurrentUserContext, projectId: number, approvalId: number) {
    await assertProjectAccess(this.db, this.access, u, projectId);
    return loadApproval(this.db, u.orgId, projectId, approvalId);
  }
}
