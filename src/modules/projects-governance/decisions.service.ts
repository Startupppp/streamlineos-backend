import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { projectDecisions, projects } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AuditService } from "../../common/audit/audit.service";
import type { CreateDecisionInput, ListDecisionsQuery, UpdateDecisionInput } from "./dto/governance.schemas";

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
    private readonly audit: AuditService,
  ) {}

  private async assertProject(orgId: string, projectId: number): Promise<void> {
    const p = await this.db.query.projects.findFirst({
      where: and(eq(projects.id, projectId), eq(projects.orgId, orgId)),
      columns: { id: true },
    });
    if (!p) throw new NotFoundException("Project not found");
  }

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

  async listDecisions(orgId: string, projectId: number, query: ListDecisionsQuery) {
    await this.assertProject(orgId, projectId);
    return this.db
      .select()
      .from(projectDecisions)
      .where(
        and(
          eq(projectDecisions.orgId, orgId),
          eq(projectDecisions.projectId, projectId),
          isNull(projectDecisions.deletedAt),
          query.status ? eq(projectDecisions.status, query.status) : undefined,
        ),
      )
      .orderBy(desc(projectDecisions.createdAt));
  }

  async getDecision(orgId: string, projectId: number, decisionId: number) {
    return this.loadDecision(orgId, projectId, decisionId);
  }

  async createDecision(
    orgId: string,
    userId: string,
    projectId: number,
    input: CreateDecisionInput,
  ) {
    await this.assertProject(orgId, projectId);
    const [decision] = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${projectId})`);
      const [maxRow] = await tx
        .select({ maxNum: sql<number>`COALESCE(MAX(${projectDecisions.decisionNumber}), 0)` })
        .from(projectDecisions)
        .where(and(eq(projectDecisions.projectId, projectId), eq(projectDecisions.orgId, orgId)));
      const nextNumber = (maxRow?.maxNum ?? 0) + 1;
      return tx
        .insert(projectDecisions)
        .values({
          orgId,
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
          createdBy: userId,
        })
        .returning();
    });
    if (!decision) throw new NotFoundException("Failed to create decision");
    this.audit.log({
      action: "decision.created",
      userId,
      orgId,
      resourceType: "project_decision",
      resourceId: String(decision.id),
      metadata: { projectId, decisionId: decision.id, title: decision.title },
    });
    return decision;
  }

  async updateDecision(
    orgId: string,
    userId: string,
    projectId: number,
    decisionId: number,
    input: UpdateDecisionInput,
  ) {
    await this.loadDecision(orgId, projectId, decisionId);
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
      .where(and(eq(projectDecisions.id, decisionId), eq(projectDecisions.orgId, orgId)))
      .returning();
    if (!updated) throw new NotFoundException("Decision not found");

    this.audit.log({
      action: "decision.updated",
      userId,
      orgId,
      resourceType: "project_decision",
      resourceId: String(decisionId),
      metadata: { projectId, decisionId },
    });
    return updated;
  }

  async softDeleteDecision(orgId: string, userId: string, projectId: number, decisionId: number) {
    await this.loadDecision(orgId, projectId, decisionId);
    await this.db
      .update(projectDecisions)
      .set({ deletedAt: new Date() })
      .where(and(eq(projectDecisions.id, decisionId), eq(projectDecisions.orgId, orgId)));
    this.audit.log({
      action: "decision.deleted",
      userId,
      orgId,
      resourceType: "project_decision",
      resourceId: String(decisionId),
      metadata: { projectId, decisionId },
    });
  }
}
