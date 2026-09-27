import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";
import { projectDecisions } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { AccessService } from "../../access/access.service";
import { assertProjectAccess } from "../core/project-access";
import type { CreateDecisionInput, ListDecisionsQuery, UpdateDecisionInput } from "./dto/governance.schemas";
import { buildIdCursorPage } from "../../../common/pagination/cursor";

type DecisionPatch = Partial<
  Pick<
    typeof projectDecisions.$inferInsert,
    | "title"
    | "context"
    | "decision"
    | "optionsConsidered"
    | "status"
    | "ownerId"
    | "decidedAt"
    | "revisitAt"
    | "linkedTicketId"
  >
>;

@Injectable()
export class DecisionsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  private async loadDecision(orgId: string, projectId: number, decisionId: number) {
    const row = await this.db.query.projectDecisions.findFirst({
      where: and(
        eq(projectDecisions.id, decisionId),
        eq(projectDecisions.orgId, orgId),
        eq(projectDecisions.projectId, projectId),
        isNull(projectDecisions.deletedAt),
      ),
    });
    if (!row) throw new NotFoundException("Decision not found");
    return row;
  }

  private static readonly PAGE_LIMIT = 100;

  async listDecisions(u: CurrentUserContext, projectId: number, query: ListDecisionsQuery) {
    await assertProjectAccess(this.db, this.access, u, projectId);
    const rows = await this.db
      .select()
      .from(projectDecisions)
      .where(
        and(
          eq(projectDecisions.orgId, u.orgId),
          eq(projectDecisions.projectId, projectId),
          isNull(projectDecisions.deletedAt),
          query.status ? eq(projectDecisions.status, query.status) : undefined,
          query.ownerId ? eq(projectDecisions.ownerId, query.ownerId) : undefined,
          query.cursor !== undefined ? lt(projectDecisions.id, query.cursor) : undefined,
          query.search
            ? sql`to_tsvector('english', coalesce(${projectDecisions.title}, '')) @@ plainto_tsquery('english', ${query.search})`
            : undefined,
        ),
      )
      .orderBy(desc(projectDecisions.id))
      .limit(DecisionsService.PAGE_LIMIT + 1);
    return buildIdCursorPage(rows, DecisionsService.PAGE_LIMIT, (r) => r.id);
  }

  async getDecision(u: CurrentUserContext, projectId: number, decisionId: number) {
    await assertProjectAccess(this.db, this.access, u, projectId);
    return this.loadDecision(u.orgId, projectId, decisionId);
  }

  async createDecision(u: CurrentUserContext, projectId: number, input: CreateDecisionInput) {
    await assertProjectAccess(this.db, this.access, u, projectId);
    const [decision] = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${projectId})`);
      const [maxRow] = await tx
        .select({ maxNum: sql<number>`COALESCE(MAX(${projectDecisions.decisionNumber}), 0)` })
        .from(projectDecisions)
        .where(and(eq(projectDecisions.projectId, projectId), eq(projectDecisions.orgId, u.orgId)));
      const nextNumber = (maxRow?.maxNum ?? 0) + 1;
      return tx
        .insert(projectDecisions)
        .values({
          orgId: u.orgId,
          projectId,
          decisionNumber: nextNumber,
          title: input.title,
          context: input.context ?? null,
          decision: input.decision ?? null,
          optionsConsidered: input.optionsConsidered ?? null,
          status: input.status ?? "proposed",
          ownerId: input.ownerId ?? null,
          decidedAt: input.decidedAt ?? null,
          revisitAt: input.revisitAt ?? null,
          linkedTicketId: input.linkedTicketId ?? null,
          createdBy: u.userId,
        })
        .returning();
    });
    if (!decision) throw new NotFoundException("Failed to create decision");
    this.audit.log({
      action: "decision.created",
      userId: u.userId,
      orgId: u.orgId,
      resourceType: "project_decision",
      resourceId: String(decision.id),
      metadata: { projectId, decisionId: decision.id, title: decision.title },
    });
    return decision;
  }

  async updateDecision(
    u: CurrentUserContext,
    projectId: number,
    decisionId: number,
    input: UpdateDecisionInput,
  ) {
    await assertProjectAccess(this.db, this.access, u, projectId);
    await this.loadDecision(u.orgId, projectId, decisionId);
    const patch: DecisionPatch = {};
    if (input.title !== undefined) patch.title = input.title;
    if (input.context !== undefined) patch.context = input.context ?? null;
    if (input.decision !== undefined) patch.decision = input.decision ?? null;
    if (input.optionsConsidered !== undefined) patch.optionsConsidered = input.optionsConsidered ?? null;
    if (input.status !== undefined) patch.status = input.status;
    if (input.ownerId !== undefined) patch.ownerId = input.ownerId ?? null;
    if (input.decidedAt !== undefined) patch.decidedAt = input.decidedAt ?? null;
    if (input.revisitAt !== undefined) patch.revisitAt = input.revisitAt ?? null;
    if (input.linkedTicketId !== undefined) patch.linkedTicketId = input.linkedTicketId ?? null;

    const [updated] = await this.db
      .update(projectDecisions)
      .set(patch)
      .where(and(eq(projectDecisions.id, decisionId), eq(projectDecisions.orgId, u.orgId), eq(projectDecisions.projectId, projectId)))
      .returning();
    if (!updated) throw new NotFoundException("Decision not found");

    this.audit.log({
      action: "decision.updated",
      userId: u.userId,
      orgId: u.orgId,
      resourceType: "project_decision",
      resourceId: String(decisionId),
      metadata: { projectId, decisionId },
    });
    return updated;
  }

  async softDeleteDecision(u: CurrentUserContext, projectId: number, decisionId: number) {
    await assertProjectAccess(this.db, this.access, u, projectId);
    await this.loadDecision(u.orgId, projectId, decisionId);
    await this.db
      .update(projectDecisions)
      .set({ deletedAt: new Date() })
      .where(and(eq(projectDecisions.id, decisionId), eq(projectDecisions.orgId, u.orgId), eq(projectDecisions.projectId, projectId)));
    this.audit.log({
      action: "decision.deleted",
      userId: u.userId,
      orgId: u.orgId,
      resourceType: "project_decision",
      resourceId: String(decisionId),
      metadata: { projectId, decisionId },
    });
  }
}
