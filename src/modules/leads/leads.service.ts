import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import {
  eq,
  and,
  desc,
  asc,
  sql,
  count,
  gte,
  lte,
  or,
  inArray,
  type SQL,
} from "drizzle-orm";
import {
  leads,
  leadActivities,
  notifications,
  organizationMembers,
  users,
  crmOptions,
  crmPipelines,
  crmPipelineStages,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { AuditService } from "../../common/audit/audit.service";
import { logger } from "../../common/logger/logger.service";
import { EmailService } from "../email/email.service";
import { AutomationService } from "../automation/automation.service";
import { WebhooksDispatchService } from "../webhooks/webhooks-dispatch.service";
import { CrmAutomationBusService } from "../crm-automation-studio/crm-automation-bus.service";
import { CrmValidationService } from "../crm-metadata/crm-validation.service";
import { CrmBlueprintsService } from "../crm-metadata/crm-blueprints.service";
import { CrmAttributionReportService } from "../crm/crm-attribution-report.service";
import { TerritoryMatchService } from "../crm/territory-match.service";
import { pushBranchAssigneeFilter, type BranchContext } from "./branch-filter";
import { applyScope } from "../access/apply-scope";
import type { DataScope } from "../access/access.types";
import {
  evaluateAssignmentRules,
  recalculateLeadScore,
  applySlaPolicy,
} from "./lead-triggers";
import { resolveLeadStatusSemantics } from "./lead-status-semantics";
import type {
  ListInput,
  CreateInput,
  UpdateInput,
  IngestInput,
} from "./dto/lead.schemas";

type ListFilters = ListInput & { userId?: string; branch?: BranchContext; scope?: DataScope };
type BoardOpts = { userId?: string; branch?: BranchContext; limitPerStatus?: number; scope?: DataScope };
type StatsFilters = { dateFrom?: string; dateTo?: string; userId?: string; branch?: BranchContext; scope?: DataScope };

function pushLeadsViewScope(
  where: SQL[],
  scope: DataScope | undefined,
  userId: string | undefined,
): void {
  if (!scope) return;
  if (scope === "none") {
    where.push(sql`false`);
    return;
  }
  if (!userId) return;
  where.push(applyScope(scope, userId, { ownerColumn: leads.assignedToId }));
}

export type AssigneeNotMember = { error: "assignee_not_member" };

export function isAssigneeNotMember(value: unknown): value is AssigneeNotMember {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    value.error === "assignee_not_member"
  );
}

@Injectable()
export class LeadsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
    private readonly email: EmailService,
    private readonly automation: AutomationService,
    private readonly webhooksDispatch: WebhooksDispatchService,
    private readonly crmValidation: CrmValidationService,
    private readonly blueprints: CrmBlueprintsService,
    private readonly bus: CrmAutomationBusService,
    private readonly attribution: CrmAttributionReportService,
    private readonly territoryMatch: TerritoryMatchService,
  ) {}

  private async sendLeadAssignedNotification(
    actorId: string,
    lead: { assignedToId: string; name: string; source: string; priority: string },
  ): Promise<void> {
    const ids = Array.from(new Set([lead.assignedToId, actorId]));
    const people = await this.db
      .select({ id: users.id, email: users.email, name: users.name })
      .from(users)
      .where(inArray(users.id, ids));

    const rep = people.find((p) => p.id === lead.assignedToId);
    if (!rep?.email) return;

    const actor = people.find((p) => p.id === actorId);
    await this.email.sendLeadAssignedEmail(
      rep.email,
      rep.name ?? "Team Member",
      lead.name,
      lead.source,
      lead.priority,
      actor?.name ?? "Manager",
    );
  }

  async listLeads(orgId: string, filters?: ListFilters) {
    const where = [eq(leads.orgId, orgId)];

    if (filters?.branch) {
      await pushBranchAssigneeFilter(this.db, where, leads.assignedToId, filters.branch);
    }

    pushLeadsViewScope(where, filters?.scope, filters?.userId);
    if (filters?.status) where.push(eq(leads.status, filters.status));
    if (filters?.priority) where.push(eq(leads.priority, filters.priority));
    if (filters?.source) where.push(eq(leads.source, filters.source));
    if (filters?.assignedToId) where.push(eq(leads.assignedToId, filters.assignedToId));
    if (filters?.dateFrom) where.push(gte(leads.createdAt, new Date(filters.dateFrom)));
    if (filters?.dateTo) where.push(lte(leads.createdAt, new Date(filters.dateTo)));
    if (filters?.search) {
      const s = `%${filters.search.toLowerCase()}%`;
      where.push(
        or(
          sql`LOWER(${leads.name}) LIKE ${s}`,
          sql`LOWER(${leads.email}) LIKE ${s}`,
          sql`${leads.phone} LIKE ${s}`,
          sql`LOWER(${leads.company}) LIKE ${s}`,
        )!,
      );
    }

    const colMap = {
      name: leads.name,
      email: leads.email,
      company: leads.company,
      status: leads.status,
      priority: leads.priority,
      source: leads.source,
      score: leads.score,
      potentialValue: leads.potentialValue,
      createdAt: leads.createdAt,
    } as const;

    const sortBy = filters?.sortBy ?? "createdAt";
    const sortOrder = filters?.sortOrder ?? "desc";
    const orderCol = colMap[sortBy as keyof typeof colMap] ?? leads.createdAt;
    const orderFn = sortOrder === "asc" ? asc(orderCol) : desc(orderCol);

    const page = filters?.page ?? 1;
    const limit = filters?.limit ?? 50;
    const offset = (page - 1) * limit;
    const whereClause = and(...where);

    const [allLeads, totalResult] = await Promise.all([
      this.db.query.leads.findMany({
        where: whereClause,
        with: {
          assignedTo: { columns: { id: true, name: true, image: true } },
          campaign: { columns: { id: true, name: true } },
        },
        orderBy: [orderFn],
        limit,
        offset,
      }),
      this.db.select({ count: count() }).from(leads).where(whereClause),
    ]);

    const totalCount = totalResult[0]?.count ?? 0;
    return {
      leads: allLeads,
      totalCount,
      page,
      totalPages: Math.ceil(totalCount / limit),
    };
  }

  private async resolveLeadStatusKeys(orgId: string): Promise<string[]> {
    const defaultLeadPipeline = await this.db
      .select({ id: crmPipelines.id })
      .from(crmPipelines)
      .where(and(eq(crmPipelines.orgId, orgId), eq(crmPipelines.type, "lead"), eq(crmPipelines.isDefault, true), eq(crmPipelines.isActive, true)))
      .limit(1)
      .then((r) => r[0]);

    if (defaultLeadPipeline) {
      const stages = await this.db
        .select({ key: crmPipelineStages.key })
        .from(crmPipelineStages)
        .where(and(eq(crmPipelineStages.orgId, orgId), eq(crmPipelineStages.pipelineId, defaultLeadPipeline.id), eq(crmPipelineStages.isActive, true)))
        .orderBy(asc(crmPipelineStages.sortOrder));
      if (stages.length > 0) return stages.map((s) => s.key);
    }

    const options = await this.db
      .select({ key: crmOptions.key })
      .from(crmOptions)
      .where(and(eq(crmOptions.orgId, orgId), eq(crmOptions.type, "lead_status"), eq(crmOptions.isActive, true)))
      .orderBy(asc(crmOptions.sortOrder));
    if (options.length > 0) return options.map((o) => o.key);

    const existing = await this.db
      .selectDistinct({ status: leads.status })
      .from(leads)
      .where(eq(leads.orgId, orgId));
    return existing.map((r) => r.status);
  }

  async getBoard(orgId: string, opts?: BoardOpts) {
    const baseFilters = [eq(leads.orgId, orgId)];

    if (opts?.branch) {
      await pushBranchAssigneeFilter(this.db, baseFilters, leads.assignedToId, opts.branch);
    }

    pushLeadsViewScope(baseFilters, opts?.scope, opts?.userId);

    const statusKeys = await this.resolveLeadStatusKeys(orgId);
    const limitPerStatus = opts?.limitPerStatus ?? 50;

    const columns = {
      id: leads.id,
      name: leads.name,
      email: leads.email,
      phone: leads.phone,
      company: leads.company,
      source: leads.source,
      priority: leads.priority,
      status: leads.status,
      score: leads.score,
      potentialValue: leads.potentialValue,
      slaDeadline: leads.slaDeadline,
      assignedToId: leads.assignedToId,
      createdAt: leads.createdAt,
    } as const;

    const columnResults = await Promise.all(
      statusKeys.map(async (status) => {
        const statusFilter = [...baseFilters, eq(leads.status, status)];
        const [rows, countResult] = await Promise.all([
          this.db
            .select(columns)
            .from(leads)
            .where(and(...statusFilter))
            .orderBy(desc(leads.createdAt))
            .limit(limitPerStatus),
          this.db.select({ total: count() }).from(leads).where(and(...statusFilter)),
        ]);

        const assigneeIds = [...new Set(rows.map((r) => r.assignedToId).filter((id): id is string => !!id))];
        const assigneeMap = new Map<string, { id: string; name: string | null; image: string | null }>();
        if (assigneeIds.length > 0) {
          const assignees = await this.db
            .select({ id: users.id, name: users.name, image: users.image })
            .from(users)
            .where(inArray(users.id, assigneeIds));
          for (const a of assignees) assigneeMap.set(a.id, a);
        }

        return {
          status,
          total: countResult[0]?.total ?? 0,
          leads: rows.map((r) => ({
            ...r,
            assignedTo: r.assignedToId ? (assigneeMap.get(r.assignedToId) ?? null) : null,
          })),
        };
      }),
    );

    const board: Record<string, { leads: (typeof columnResults)[0]["leads"]; total: number }> = {};
    for (const col of columnResults) {
      board[col.status] = { leads: col.leads, total: col.total };
    }

    return board;
  }

  async getStats(orgId: string, filters?: StatsFilters) {
    const statsFilters = [eq(leads.orgId, orgId)];
    if (filters?.branch) {
      await pushBranchAssigneeFilter(this.db, statsFilters, leads.assignedToId, filters.branch);
    }
    pushLeadsViewScope(statsFilters, filters?.scope, filters?.userId);

    if (filters?.dateFrom) {
      statsFilters.push(gte(leads.createdAt, new Date(filters.dateFrom)));
    }
    if (filters?.dateTo) {
      const to = new Date(filters.dateTo);
      to.setHours(23, 59, 59, 999);
      statsFilters.push(lte(leads.createdAt, to));
    }

    const now = new Date();
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const [statusCounts, totals, statusOptions] = await Promise.all([
      this.db
        .select({ status: leads.status, cnt: count() })
        .from(leads)
        .where(and(...statsFilters))
        .groupBy(leads.status),
      this.db
        .select({
          total: count(),
          totalPotentialValue: sql<string>`COALESCE(SUM(CAST(${leads.potentialValue} AS NUMERIC)), 0)`,
          unassigned: sql<string>`COUNT(*) FILTER (WHERE ${leads.assignedToId} IS NULL)`,
          thisMonth: sql<string>`COUNT(*) FILTER (WHERE ${leads.createdAt} >= ${thisMonthStart})`,
        })
        .from(leads)
        .where(and(...statsFilters)),
      this.db.select().from(crmOptions).where(and(eq(crmOptions.orgId, orgId), eq(crmOptions.type, "lead_status"))),
    ]);

    const semantics = resolveLeadStatusSemantics(statusOptions);
    const byStatusMap = new Map(statusCounts.map((r) => [r.status, Number(r.cnt)]));
    const byStatus: Record<string, number> = {};
    for (const [status, cnt] of byStatusMap) byStatus[status] = cnt;

    const convertedCount = semantics.convertedKeys.reduce((s, k) => s + (byStatusMap.get(k) ?? 0), 0);
    const aggRow = totals[0];
    const total = Number(aggRow?.total ?? 0);
    const conversionRate = total > 0 ? (convertedCount / total) * 100 : 0;

    return {
      total,
      byStatus,
      conversionRate: Math.round(conversionRate * 10) / 10,
      totalPotentialValue: Number(aggRow?.totalPotentialValue ?? 0),
      unassigned: Number(aggRow?.unassigned ?? 0),
      thisMonth: Number(aggRow?.thisMonth ?? 0),
    };
  }

  async getLead(orgId: string, id: number) {
    return this.db.query.leads.findFirst({
      where: and(eq(leads.id, id), eq(leads.orgId, orgId)),
      with: {
        assignedTo: { columns: { id: true, name: true, image: true, email: true } },
        assignedBy: { columns: { id: true, name: true } },
        campaign: { columns: { id: true, name: true } },
        activities: {
          with: { user: { columns: { id: true, name: true, image: true } } },
          orderBy: [desc(leadActivities.date)],
        },
      },
    });
  }

  async create(orgId: string, userId: string, input: CreateInput) {
    if (input.assignedToId) {
      const member = await this.db.query.organizationMembers.findFirst({
        where: and(eq(organizationMembers.userId, input.assignedToId), eq(organizationMembers.orgId, orgId)),
        columns: { userId: true },
      });
      if (!member) {
        const notMember: AssigneeNotMember = { error: "assignee_not_member" };
        return notMember;
      }
    }

    const record: Record<string, unknown> = {
      name: input.name,
      email: input.email ?? null,
      phone: input.phone ?? null,
      source: input.source,
      priority: input.priority,
      potentialValue: input.potentialValue ?? null,
    };
    const validation = await this.crmValidation.evaluate(orgId, "lead", record, {
      sourceKey: input.source,
    });
    if (!validation.valid) {
      throw new BadRequestException(validation.errors.map((e) => e.message).join("; "));
    }

    const [newLead] = await this.db.insert(leads).values({
      orgId,
      name: input.name,
      email: input.email || null,
      phone: input.phone,
      whatsappNumber: input.whatsappNumber,
      source: input.source,
      campaignId: input.campaignId,
      priority: input.priority,
      investmentInterest: input.investmentInterest,
      potentialValue: input.potentialValue,
      notes: input.notes,
      company: input.company,
      designation: input.designation,
      city: input.city,
      referredBy: input.referredBy,
      tags: input.tags,
      assignedToId: input.assignedToId || null,
      assignedById: input.assignedToId ? userId : null,
      assignedAt: input.assignedToId ? new Date() : null,
    }).returning();

    if (input.assignedToId) {
      await this.db.insert(notifications).values({
        orgId,
        userId: input.assignedToId,
        type: "INFO",
        title: "New Lead Assigned",
        message: `You have been assigned a new lead: ${input.name}`,
        link: `/crm/leads`,
      });
    }

    if (!input.assignedToId) {
      try {
        await evaluateAssignmentRules(this.db, orgId, newLead.id, this.territoryMatch);
      } catch (error) {
        logger.error("Auto-trigger: assignment rules failed", { leadId: newLead.id, error });
      }
    }

    try {
      const scoreResult = await recalculateLeadScore(this.db, orgId, newLead.id);
      if (scoreResult?.changed) {
        void this.bus.emit(orgId, "lead.score_changed", { entityType: "lead", entityId: String(newLead.id), data: { score: scoreResult.score, dimensionBreakdown: scoreResult.dimensionBreakdown }, actorId: userId }).catch(() => undefined);
      }
    } catch (error) {
      logger.error("Auto-trigger: lead scoring failed", { leadId: newLead.id, error });
    }

    try {
      await applySlaPolicy(this.db, orgId, newLead.id);
    } catch (error) {
      logger.error("Auto-trigger: SLA policy failed", { leadId: newLead.id, error });
    }

    await this.cache.invalidatePattern(`leads:*:${orgId}:*`);

    this.audit.log({
      action: "lead.created",
      userId,
      orgId,
      targetId: String(newLead.id),
      targetType: "lead",
      metadata: { name: newLead.name, source: newLead.source, assignedToId: newLead.assignedToId },
    });

    void this.attribution.recordTouch({
      orgId,
      leadId: newLead.id,
      campaignId: input.campaignId ?? null,
      sourceKey: input.source ?? "direct",
      touchType: "first_touch",
      occurredAt: newLead.createdAt ?? new Date(),
    }).catch(() => undefined);

    if (newLead.assignedToId) {
      void this.sendLeadAssignedNotification(userId, {
        assignedToId: newLead.assignedToId,
        name: newLead.name,
        source: newLead.source,
        priority: newLead.priority,
      }).catch(() => undefined);
    }

    void this.automation
      .runAutomationsForEvent(orgId, "lead.created", {
        id: newLead.id,
        name: newLead.name,
        email: newLead.email,
        source: newLead.source,
        assignedToId: newLead.assignedToId,
      })
      .catch(() => undefined);

    void this.bus.emit(orgId, "lead.created", { entityType: "lead", entityId: String(newLead.id), data: { name: newLead.name, source: newLead.source, assignedToId: newLead.assignedToId }, actorId: userId }).catch(() => undefined);

    this.webhooksDispatch.dispatch(orgId, "lead.created", {
      id: newLead.id,
      name: newLead.name,
      email: newLead.email,
      source: newLead.source,
      assignedToId: newLead.assignedToId,
    });

    return newLead;
  }

  async update(orgId: string, userId: string, id: number, input: UpdateInput) {
    const existing = await this.db.query.leads.findFirst({
      where: and(eq(leads.id, id), eq(leads.orgId, orgId)),
    });
    if (!existing) return null;

    const record: Record<string, unknown> = {
      name: input.name ?? existing.name,
      email: input.email ?? existing.email,
      phone: input.phone ?? existing.phone,
      source: input.source ?? existing.source,
      priority: input.priority ?? existing.priority,
      potentialValue: input.potentialValue ?? existing.potentialValue,
    };
    const validation = await this.crmValidation.evaluate(orgId, "lead", record, {
      sourceKey: (input.source ?? existing.source) ?? undefined,
      existingRecordId: String(id),
    });
    if (!validation.valid) {
      throw new BadRequestException(validation.errors.map((e) => e.message).join("; "));
    }

    const [updated] = await this.db.update(leads)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(leads.id, id), eq(leads.orgId, orgId)))
      .returning();

    if (!updated) return null;

    this.audit.log({
      action: "lead.updated",
      userId,
      orgId,
      targetId: String(id),
      targetType: "lead",
      metadata: { changedFields: Object.keys(input) },
    });

    try {
      const scoreResult = await recalculateLeadScore(this.db, orgId, updated.id);
      if (scoreResult?.changed) {
        void this.bus.emit(orgId, "lead.score_changed", { entityType: "lead", entityId: String(updated.id), data: { score: scoreResult.score, dimensionBreakdown: scoreResult.dimensionBreakdown }, actorId: userId }).catch(() => undefined);
      }
    } catch (error) {
      logger.error("Auto-trigger: lead scoring on update failed", { leadId: updated.id, error });
    }

    const changedFields = Object.keys(input);

    if (changedFields.includes("source") || changedFields.includes("campaignId")) {
      void this.attribution.recordTouch({
        orgId,
        leadId: updated.id,
        campaignId: updated.campaignId ?? null,
        sourceKey: updated.source ?? "direct",
        touchType: "interaction",
        occurredAt: new Date(),
      }).catch(() => undefined);
    }

    if (changedFields.includes("status")) {
      void this.automation
        .runAutomationsForEvent(orgId, "lead.status_changed", {
          id: updated.id,
          name: updated.name,
          status: updated.status,
          previousStatus: existing.status,
        })
        .catch(() => undefined);
      void this.bus.emit(orgId, "lead.stage_changed", { entityType: "lead", entityId: String(updated.id), data: { status: updated.status, previousStatus: existing.status }, actorId: userId }).catch(() => undefined);
    }

    if (changedFields.includes("assignedToId") && updated.assignedToId) {
      void this.automation
        .runAutomationsForEvent(orgId, "lead.assigned", {
          id: updated.id,
          name: updated.name,
          assignedToId: updated.assignedToId,
          previousAssignedToId: existing.assignedToId,
        })
        .catch(() => undefined);

      void this.bus.emit(orgId, "lead.assigned", { entityType: "lead", entityId: String(updated.id), data: { assignedToId: updated.assignedToId }, actorId: userId }).catch(() => undefined);

      void this.sendLeadAssignedNotification(userId, {
        assignedToId: updated.assignedToId,
        name: updated.name,
        source: updated.source,
        priority: updated.priority,
      }).catch(() => undefined);
    }

    this.webhooksDispatch.dispatch(orgId, "lead.updated", {
      id: updated.id,
      name: updated.name,
      email: updated.email,
      source: updated.source,
      status: updated.status,
      assignedToId: updated.assignedToId,
      changedFields,
    });

    void this.bus.emit(orgId, "lead.updated", { entityType: "lead", entityId: String(updated.id), data: { changedFields }, actorId: userId }).catch(() => undefined);

    return updated;
  }

  async remove(orgId: string, userId: string, id: number) {
    await this.db.delete(leads)
      .where(and(eq(leads.id, id), eq(leads.orgId, orgId)));
    this.audit.log({
      action: "lead.deleted",
      userId,
      orgId,
      targetId: String(id),
      targetType: "lead",
    });
    return { success: true };
  }

  async ingestCreate(orgId: string, input: IngestInput) {
    const [lead] = await this.db
      .insert(leads)
      .values({
        orgId,
        name: input.name ?? input.email ?? input.phone ?? "Unknown",
        email: input.email ?? null,
        phone: input.phone ?? null,
        company: input.company ?? null,
        source: "other" as const,
        notes: input.notes ?? null,
        status: "NEW" as const,
      })
      .returning({ id: leads.id });

    void Promise.allSettled([
      evaluateAssignmentRules(this.db, orgId, lead.id, this.territoryMatch).catch((e: unknown) =>
        logger.error("Ingest: assignment rules failed", { leadId: lead.id, error: e }),
      ),
      recalculateLeadScore(this.db, orgId, lead.id).catch((e: unknown) =>
        logger.error("Ingest: lead scoring failed", { leadId: lead.id, error: e }),
      ),
      applySlaPolicy(this.db, orgId, lead.id).catch((e: unknown) =>
        logger.error("Ingest: SLA policy failed", { leadId: lead.id, error: e }),
      ),
    ]);

    return { id: lead.id };
  }
}
