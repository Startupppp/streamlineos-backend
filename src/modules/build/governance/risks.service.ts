import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, isNull, lt, notInArray, sql } from "drizzle-orm";
import { projectRisks } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { AccessService } from "../../access/access.service";
import { assertProjectAccess, assertProjectWriteAccess } from "../core";
import type { CreateRiskInput, ListRisksQuery, UpdateRiskInput } from "./dto/governance.schemas";
import type { OrgListRisksQuery } from "./dto/org-governance.schemas";
import { buildIdCursorPage } from "../../../common/pagination/cursor";

type RiskPatch = Partial<
  Pick<
    typeof projectRisks.$inferInsert,
    "title" | "description" | "probability" | "impact" | "status" | "ownerId" | "mitigation" | "linkedTicketId"
  >
>;

@Injectable()
export class RisksService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  private async loadRisk(orgId: string, projectId: number, riskId: number) {
    const row = await this.db.query.projectRisks.findFirst({
      where: and(
        eq(projectRisks.id, riskId),
        eq(projectRisks.orgId, orgId),
        eq(projectRisks.projectId, projectId),
        isNull(projectRisks.deletedAt),
      ),
    });
    if (!row) throw new NotFoundException("Risk not found");
    return row;
  }

  private static readonly PAGE_LIMIT = 100;

  private static readonly RISK_COLUMNS = {
    id: projectRisks.id,
    orgId: projectRisks.orgId,
    projectId: projectRisks.projectId,
    riskNumber: projectRisks.riskNumber,
    title: projectRisks.title,
    description: projectRisks.description,
    probability: projectRisks.probability,
    impact: projectRisks.impact,
    status: projectRisks.status,
    ownerId: projectRisks.ownerId,
    mitigation: projectRisks.mitigation,
    linkedTicketId: projectRisks.linkedTicketId,
    createdBy: projectRisks.createdBy,
    createdAt: projectRisks.createdAt,
    updatedAt: projectRisks.updatedAt,
    deletedAt: projectRisks.deletedAt,
  };

  private static readonly SEVERITY_SCORE = sql`
    (CASE ${projectRisks.probability} WHEN 'low' THEN 1 WHEN 'medium' THEN 2 WHEN 'high' THEN 3 ELSE 0 END)
    * (CASE ${projectRisks.impact} WHEN 'low' THEN 1 WHEN 'medium' THEN 2 WHEN 'high' THEN 3 ELSE 0 END)
  `;

  async getRiskStats(u: CurrentUserContext, projectId: number) {
    await assertProjectAccess(this.db, this.access, u, projectId);
    const registerScope = and(
      eq(projectRisks.orgId, u.orgId),
      eq(projectRisks.projectId, projectId),
      isNull(projectRisks.deletedAt),
    );
    const [totals, matrix] = await Promise.all([
      this.db
        .select({
          total: sql<number>`COUNT(*)::int`,
          open: sql<number>`COUNT(*) FILTER (WHERE ${projectRisks.status} = 'open')::int`,
          closed: sql<number>`COUNT(*) FILTER (WHERE ${projectRisks.status} = 'closed')::int`,
          highCritical: sql<number>`COUNT(*) FILTER (WHERE ${RisksService.SEVERITY_SCORE} >= 6)::int`,
        })
        .from(projectRisks)
        .where(registerScope),
      this.db
        .select({
          probability: projectRisks.probability,
          impact: projectRisks.impact,
          openCount: sql<number>`COUNT(*)::int`,
        })
        .from(projectRisks)
        .where(and(registerScope, notInArray(projectRisks.status, ["closed", "accepted"])))
        .groupBy(projectRisks.probability, projectRisks.impact),
    ]);
    const row = totals[0];
    return {
      total: row?.total ?? 0,
      open: row?.open ?? 0,
      closed: row?.closed ?? 0,
      highCritical: row?.highCritical ?? 0,
      matrix,
    };
  }

  async listOrgRisks(u: CurrentUserContext, query: OrgListRisksQuery) {
    const { limit, cursor, status } = query;
    const rows = await this.db
      .select(RisksService.RISK_COLUMNS)
      .from(projectRisks)
      .where(
        and(
          eq(projectRisks.orgId, u.orgId),
          isNull(projectRisks.deletedAt),
          status ? eq(projectRisks.status, status) : undefined,
          cursor !== undefined ? lt(projectRisks.id, cursor) : undefined,
        ),
      )
      .orderBy(desc(projectRisks.id))
      .limit(limit + 1);
    return buildIdCursorPage(rows, limit, (r) => r.id);
  }

  async listRisks(u: CurrentUserContext, projectId: number, query: ListRisksQuery) {
    await assertProjectAccess(this.db, this.access, u, projectId);
    const rows = await this.db
      .select(RisksService.RISK_COLUMNS)
      .from(projectRisks)
      .where(
        and(
          eq(projectRisks.orgId, u.orgId),
          eq(projectRisks.projectId, projectId),
          isNull(projectRisks.deletedAt),
          query.status ? eq(projectRisks.status, query.status) : undefined,
          query.probability ? eq(projectRisks.probability, query.probability) : undefined,
          query.impact ? eq(projectRisks.impact, query.impact) : undefined,
          query.ownerId ? eq(projectRisks.ownerId, query.ownerId) : undefined,
          query.search
            ? sql`to_tsvector('english', coalesce(${projectRisks.title}, '') || ' ' || coalesce(${projectRisks.description}, '')) @@ plainto_tsquery('english', ${query.search})`
            : undefined,
          query.cursor !== undefined ? lt(projectRisks.id, query.cursor) : undefined,
        ),
      )
      .orderBy(desc(projectRisks.id))
      .limit(RisksService.PAGE_LIMIT + 1);
    return buildIdCursorPage(rows, RisksService.PAGE_LIMIT, (r) => r.id);
  }

  async getRisk(u: CurrentUserContext, projectId: number, riskId: number) {
    await assertProjectAccess(this.db, this.access, u, projectId);
    return this.loadRisk(u.orgId, projectId, riskId);
  }

  async createRisk(u: CurrentUserContext, projectId: number, input: CreateRiskInput) {
    await assertProjectWriteAccess(this.db, this.access, u, projectId);
    const [risk] = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${projectId})`);
      const [maxRow] = await tx
        .select({ maxNum: sql<number>`COALESCE(MAX(${projectRisks.riskNumber}), 0)` })
        .from(projectRisks)
        .where(and(eq(projectRisks.projectId, projectId), eq(projectRisks.orgId, u.orgId)));
      const nextNumber = (maxRow?.maxNum ?? 0) + 1;
      return tx
        .insert(projectRisks)
        .values({
          orgId: u.orgId,
          projectId,
          riskNumber: nextNumber,
          title: input.title,
          description: input.description ?? null,
          probability: input.probability ?? "medium",
          impact: input.impact ?? "medium",
          status: input.status ?? "open",
          ownerId: input.ownerId ?? null,
          mitigation: input.mitigation ?? null,
          linkedTicketId: input.linkedTicketId ?? null,
          createdBy: u.userId,
        })
        .returning();
    });
    if (!risk) throw new NotFoundException("Failed to create risk");
    this.audit.log({
      action: "risk.created",
      userId: u.userId,
      orgId: u.orgId,
      resourceType: "project_risk",
      resourceId: String(risk.id),
      metadata: { projectId, riskId: risk.id, title: risk.title },
    });
    return risk;
  }

  async updateRisk(
    u: CurrentUserContext,
    projectId: number,
    riskId: number,
    input: UpdateRiskInput,
  ) {
    await assertProjectWriteAccess(this.db, this.access, u, projectId);
    await this.loadRisk(u.orgId, projectId, riskId);
    const patch: RiskPatch = {};
    if (input.title !== undefined) patch.title = input.title;
    if (input.description !== undefined) patch.description = input.description ?? null;
    if (input.probability !== undefined) patch.probability = input.probability;
    if (input.impact !== undefined) patch.impact = input.impact;
    if (input.status !== undefined) patch.status = input.status;
    if (input.ownerId !== undefined) patch.ownerId = input.ownerId ?? null;
    if (input.mitigation !== undefined) patch.mitigation = input.mitigation ?? null;
    if (input.linkedTicketId !== undefined) patch.linkedTicketId = input.linkedTicketId ?? null;

    const [updated] = await this.db
      .update(projectRisks)
      .set(patch)
      .where(and(eq(projectRisks.id, riskId), eq(projectRisks.orgId, u.orgId), eq(projectRisks.projectId, projectId)))
      .returning();
    if (!updated) throw new NotFoundException("Risk not found");

    this.audit.log({
      action: "risk.updated",
      userId: u.userId,
      orgId: u.orgId,
      resourceType: "project_risk",
      resourceId: String(riskId),
      metadata: { projectId, riskId },
    });
    return updated;
  }

  async softDeleteRisk(u: CurrentUserContext, projectId: number, riskId: number) {
    await assertProjectWriteAccess(this.db, this.access, u, projectId);
    await this.loadRisk(u.orgId, projectId, riskId);
    await this.db
      .update(projectRisks)
      .set({ deletedAt: new Date() })
      .where(and(eq(projectRisks.id, riskId), eq(projectRisks.orgId, u.orgId), eq(projectRisks.projectId, projectId)));
    this.audit.log({
      action: "risk.deleted",
      userId: u.userId,
      orgId: u.orgId,
      resourceType: "project_risk",
      resourceId: String(riskId),
      metadata: { projectId, riskId },
    });
  }
}
