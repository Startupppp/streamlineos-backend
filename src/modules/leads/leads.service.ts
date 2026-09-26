import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { eq, and, inArray } from "drizzle-orm";
import {
  organizationMembers,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { AuditService } from "../../common/audit/audit.service";
import { logger } from "../../common/logger/logger.service";
import { logSideEffectFailure } from "../../common/logger/side-effect";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import { AutomationService } from "../automation/automation.service";
import { WebhooksDispatchService } from "../webhooks/webhooks-dispatch.service";
import { CrmAutomationBusService } from "../crm/automation-studio/crm-automation-bus.service";
import { CrmValidationService } from "../crm/metadata/crm-validation.service";
import { CrmAttributionReportService } from "../crm/core/crm-attribution-report.service";
import { TerritoryMatchService } from "../crm/core/territory-match.service";
import { PlanLimitsService } from "../billing/core/plan-limits.service";
import type { BoardOpts, StatsFilters } from "./leads-board.service";
import { LeadsReadService, type ListFilters } from "./leads-read.service";
import { loadLeadView } from "./lead-party-reader";
import {
  evaluateAssignmentRules,
  recalculateLeadScore,
  applySlaPolicy,
} from "./lead-triggers";
import type {
  CreateInput,
  UpdateInput,
  IngestInput,
} from "./dto/lead.schemas";
import { LEAD_QUALIFICATION_FIELD } from "./dto/lead.schemas";
import {
  createMirroredLead,
  softDeleteMirroredLeads,
  updateMirroredLead,
} from "../party/party-legacy-leads";

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
    private readonly dispatch: NotificationDispatchService,
    private readonly automation: AutomationService,
    private readonly webhooksDispatch: WebhooksDispatchService,
    private readonly crmValidation: CrmValidationService,
    private readonly bus: CrmAutomationBusService,
    private readonly attribution: CrmAttributionReportService,
    private readonly territoryMatch: TerritoryMatchService,
    private readonly reads: LeadsReadService,
    private readonly planLimits: PlanLimitsService,
  ) {}

  private async sendLeadAssignedNotification(
    orgId: string,
    actorId: string,
    lead: { assignedToId: string; name: string; source: string; priority: string },
  ): Promise<void> {
    await this.dispatch.emit({
      eventKey: "crm.lead.assigned",
      orgId,
      actorUserId: actorId,
      targetUserIds: [lead.assignedToId],
      entityType: "lead",
      title: "Lead assigned to you",
      message: `You have been assigned lead: ${lead.name}`,
      link: "/crm/leads",
      variables: { leadName: lead.name, source: lead.source, priority: lead.priority },
    });
  }

  async listLeads(orgId: string, filters: ListFilters) {
    return this.reads.listLeads(orgId, filters);
  }

  async getBoard(orgId: string, opts: BoardOpts) {
    return this.reads.getBoard(orgId, opts);
  }

  async getStats(orgId: string, filters: StatsFilters) {
    return this.reads.getStats(orgId, filters);
  }

  async getLead(orgId: string, id: number) {
    return this.reads.getLead(orgId, id);
  }

  async create(orgId: string, userId: string, input: CreateInput) {
    await this.planLimits.assertWithinLimit(orgId, "crmLeads");

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

    // The party is written first and this row derived from it, in one
    // transaction; see `party-legacy-writer`. Values stay in `leads`' vocabulary
    // because that is what the DTO speaks -- the writer translates once.
    const newLead = await createMirroredLead(this.db, orgId, {
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
    });

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
        void this.bus.emit(orgId, "lead.score_changed", { entityType: "lead", entityId: String(newLead.id), data: { score: scoreResult.score, dimensionBreakdown: scoreResult.dimensionBreakdown }, actorId: userId }).catch(logSideEffectFailure("lead score-change bus emit", { orgId, leadId: newLead.id }));
      }
    } catch (error) {
      logger.error("Auto-trigger: lead scoring failed", { leadId: newLead.id, error });
    }

    try {
      await applySlaPolicy(this.db, orgId, newLead.id);
    } catch (error) {
      logger.error("Auto-trigger: SLA policy failed", { leadId: newLead.id, error });
    }

    await this.cache.invalidateNamespace(`leads:${orgId}`);

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
    }).catch(logSideEffectFailure("lead attribution first-touch", { orgId, leadId: newLead.id }));

    if (newLead.assignedToId) {
      void this.sendLeadAssignedNotification(orgId, userId, {
        assignedToId: newLead.assignedToId,
        name: newLead.name,
        source: newLead.source,
        priority: newLead.priority,
      }).catch(logSideEffectFailure("lead assigned notification email", { orgId, leadId: newLead.id }));
    }

    void this.automation
      .runAutomationsForEvent(orgId, "lead.created", {
        id: newLead.id,
        name: newLead.name,
        email: newLead.email,
        source: newLead.source,
        assignedToId: newLead.assignedToId,
      })
      .catch(logSideEffectFailure("lead.created automations", { orgId, leadId: newLead.id }));

    void this.bus.emit(orgId, "lead.created", { entityType: "lead", entityId: String(newLead.id), data: { name: newLead.name, source: newLead.source, assignedToId: newLead.assignedToId }, actorId: userId }).catch(logSideEffectFailure("lead.created bus emit", { orgId, leadId: newLead.id }));

    this.webhooksDispatch.dispatch(orgId, "lead.created", {
      id: newLead.id,
      name: newLead.name,
      email: newLead.email,
      source: newLead.source,
      assignedToId: newLead.assignedToId,
    });

    return (await this.loadLeadWithDetail(orgId, newLead.id)) ?? newLead;
  }

  async update(orgId: string, userId: string, id: number, input: UpdateInput) {
    const existing = await loadLeadView(this.db, orgId, id);
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

    const { qualification, ...mirrored } = input;
    const updated = await updateMirroredLead(this.db, orgId, id, {
      ...mirrored,
      ...(qualification
        ? { customData: { ...(existing.customData ?? {}), [LEAD_QUALIFICATION_FIELD]: qualification } }
        : {}),
      updatedAt: new Date(),
    });

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
        void this.bus.emit(orgId, "lead.score_changed", { entityType: "lead", entityId: String(updated.id), data: { score: scoreResult.score, dimensionBreakdown: scoreResult.dimensionBreakdown }, actorId: userId }).catch(logSideEffectFailure("lead score-change bus emit", { orgId, leadId: updated.id }));
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
      }).catch(logSideEffectFailure("lead attribution touch", { orgId, leadId: updated.id }));
    }

    if (changedFields.includes("status")) {
      void this.automation
        .runAutomationsForEvent(orgId, "lead.status_changed", {
          id: updated.id,
          name: updated.name,
          status: updated.status,
          previousStatus: existing.status,
        })
        .catch(logSideEffectFailure("lead.status_changed automations", { orgId, leadId: updated.id }));
      void this.bus.emit(orgId, "lead.stage_changed", { entityType: "lead", entityId: String(updated.id), data: { status: updated.status, previousStatus: existing.status }, actorId: userId }).catch(logSideEffectFailure("lead.stage_changed bus emit", { orgId, leadId: updated.id }));
    }

    if (changedFields.includes("assignedToId") && updated.assignedToId) {
      void this.automation
        .runAutomationsForEvent(orgId, "lead.assigned", {
          id: updated.id,
          name: updated.name,
          assignedToId: updated.assignedToId,
          previousAssignedToId: existing.assignedToId,
        })
        .catch(logSideEffectFailure("lead.assigned automations", { orgId, leadId: updated.id }));

      void this.bus.emit(orgId, "lead.assigned", { entityType: "lead", entityId: String(updated.id), data: { assignedToId: updated.assignedToId }, actorId: userId }).catch(logSideEffectFailure("lead.assigned bus emit", { orgId, leadId: updated.id }));

      void this.sendLeadAssignedNotification(orgId, userId, {
        assignedToId: updated.assignedToId,
        name: updated.name,
        source: updated.source,
        priority: updated.priority,
      }).catch(logSideEffectFailure("lead assigned notification email", { orgId, leadId: updated.id }));
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

    void this.bus.emit(orgId, "lead.updated", { entityType: "lead", entityId: String(updated.id), data: { changedFields }, actorId: userId }).catch(logSideEffectFailure("lead.updated bus emit", { orgId, leadId: updated.id }));

    return (await this.loadLeadWithDetail(orgId, id)) ?? updated;
  }

  private async loadLeadWithDetail(orgId: string, id: number) {
    return this.reads.getLead(orgId, id);
  }

  async remove(orgId: string, userId: string, id: number) {
    await softDeleteMirroredLeads(this.db, orgId, [id]);
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
    await this.planLimits.assertWithinLimit(orgId, "crmLeads");

    const lead = await createMirroredLead(
      this.db,
      orgId,
      {
        orgId,
        name: input.name ?? input.email ?? input.phone ?? "Unknown",
        email: input.email ?? null,
        phone: input.phone ?? null,
        company: input.company ?? null,
        source: "other" as const,
        notes: input.notes ?? null,
        status: "NEW" as const,
      },
      { linkedBy: "leads:ingest" },
    );

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
