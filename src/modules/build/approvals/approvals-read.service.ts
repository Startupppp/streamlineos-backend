import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, gt, gte, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { pendingApprovalsForActorCondition } from "./build-inbox-count.service";
import { projectApprovals, projects } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { assertProjectAccess } from "../core/project-access";
import { loadApproval } from "./approval-lookup";
import { resolveOrganizationActor } from "../../../common/organization/organization-actor";
import type { InboxQuery, ListApprovalsQuery } from "./dto/approvals.schemas";
import { buildTupleCursorPage, decodeTupleCursor } from "../../../common/pagination/cursor";

const NULL_DUE_AT = "__NULL_DUE_AT__";
const PAGE_SIZE = 100;

function decodeApprovalCursor(cursor: string | undefined): { id: number; dueAt: Date | null } | undefined {
  if (!cursor) return undefined;
  const parts = decodeTupleCursor(cursor, 2);
  if (!parts) throw new BadRequestException("Invalid pagination cursor");
  const [dueAtValue, idValue] = parts;
  const id = Number(idValue);
  if (!Number.isSafeInteger(id) || id <= 0 || id > 2_147_483_647) {
    throw new BadRequestException("Invalid pagination cursor");
  }
  if (dueAtValue === NULL_DUE_AT) return { id, dueAt: null };
  const dueAt = new Date(dueAtValue);
  if (Number.isNaN(dueAt.getTime()) || dueAt.toISOString() !== dueAtValue) {
    throw new BadRequestException("Invalid pagination cursor");
  }
  return { id, dueAt };
}

function listApprovalsKeyset(cursor: { id: number; dueAt: Date | null } | undefined): SQL | undefined {
  if (!cursor) return undefined;
  if (cursor.dueAt !== null) {
    return or(
      gt(projectApprovals.dueAt, cursor.dueAt),
      and(eq(projectApprovals.dueAt, cursor.dueAt), gt(projectApprovals.id, cursor.id)),
      isNull(projectApprovals.dueAt),
    );
  }
  return and(isNull(projectApprovals.dueAt), gt(projectApprovals.id, cursor.id));
}

@Injectable()
export class ApprovalsReadService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
  ) {}

  async getInbox(orgId: string, membershipId: number, query: InboxQuery) {
    const cursor = decodeApprovalCursor(query.cursor);
    const rows = await this.db
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
      .where(
        and(
          pendingApprovalsForActorCondition(orgId, membershipId),
          listApprovalsKeyset(cursor),
          query.status ? eq(projectApprovals.status, query.status) : undefined,
          query.type ? eq(projectApprovals.entityType, query.type) : undefined,
          query.from ? gte(projectApprovals.dueAt, query.from) : undefined,
          query.to ? lte(projectApprovals.dueAt, query.to) : undefined,
          query.q
            ? sql`to_tsvector('english', ${projectApprovals.title}) @@ plainto_tsquery('english', ${query.q})`
            : undefined,
        ),
      )
      .orderBy(sql`${projectApprovals.dueAt} ASC NULLS LAST`, asc(projectApprovals.id))
      .limit(PAGE_SIZE + 1);
    return buildTupleCursorPage(rows, PAGE_SIZE, (row) => [
      row.dueAt?.toISOString() ?? NULL_DUE_AT,
      String(row.id),
    ]);
  }

  private async approverFilter(orgId: string, approverId: string | undefined): Promise<SQL | undefined> {
    if (approverId === undefined) return undefined;
    const resolution = await resolveOrganizationActor(this.db, orgId, { kind: "user", userId: approverId });
    if (resolution.status !== "resolved") return sql`false`;
    return eq(projectApprovals.approverMembershipId, resolution.actor.membershipId);
  }

  async listApprovals(u: CurrentUserContext, projectId: number, query: ListApprovalsQuery) {
    const { orgId } = u;
    await assertProjectAccess(this.db, this.access, u, projectId);
    const cursor = decodeApprovalCursor(query.cursor);
    const approver = await this.approverFilter(orgId, query.approverId);
    const rows = await this.db
      .select()
      .from(projectApprovals)
      .where(
        and(
          eq(projectApprovals.orgId, orgId),
          eq(projectApprovals.projectId, projectId),
          isNull(projectApprovals.deletedAt),
          query.status ? eq(projectApprovals.status, query.status) : undefined,
          query.entityType ? eq(projectApprovals.entityType, query.entityType) : undefined,
          approver,
          listApprovalsKeyset(cursor),
        ),
      )
      .orderBy(sql`${projectApprovals.dueAt} ASC NULLS LAST`, asc(projectApprovals.id))
      .limit(PAGE_SIZE + 1);
    return buildTupleCursorPage(rows, PAGE_SIZE, (row) => [
      row.dueAt?.toISOString() ?? NULL_DUE_AT,
      String(row.id),
    ]);
  }

  async getApproval(u: CurrentUserContext, projectId: number, approvalId: number) {
    await assertProjectAccess(this.db, this.access, u, projectId);
    return loadApproval(this.db, u.orgId, projectId, approvalId);
  }
}
