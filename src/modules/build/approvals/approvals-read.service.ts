import { Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import { pendingApprovalsForActorCondition } from "./build-inbox-count.service";
import { projectApprovals, projects } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { assertProjectAccess } from "../core/project-access";
import { loadApproval } from "./approval-lookup";
import type { ListApprovalsQuery } from "./dto/approvals.schemas";

@Injectable()
export class ApprovalsReadService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
  ) {}

  async getInbox(orgId: string, membershipId: number) {
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
      .where(pendingApprovalsForActorCondition(orgId, membershipId))
      .orderBy(sql`${projectApprovals.dueAt} ASC NULLS LAST`)
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
        ),
      )
      .orderBy(sql`${projectApprovals.dueAt} ASC NULLS LAST`)
      .limit(100);
  }

  async getApproval(orgId: string, projectId: number, approvalId: number) {
    return loadApproval(this.db, orgId, projectId, approvalId);
  }
}
