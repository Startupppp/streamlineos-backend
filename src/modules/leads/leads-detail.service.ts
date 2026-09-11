import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { eq, and, desc, inArray } from "drizzle-orm";
import {
  leadActivities,
  leadNotes,
  leadTasks,
  leadEmails,
  leadScoringRules,
  notifications,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AuditService } from "../../common/audit/audit.service";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import { NotificationsService } from "../notifications/notifications.service";
import { logSideEffectFailure } from "../../common/logger/side-effect";
import { LeadNotificationAiService } from "./lead-notification-ai.service";
import type {
  AssignInput,
  CustomDataInput,
  LogActivityInput,
  RejectInput,
  VerifyInput,
} from "./dto/lead-mutations.schemas";
import { updateMirroredLeads } from "../party/party-legacy-leads";
import type { LeadInsert, LeadRow } from "../party/party-legacy-writer";
import { loadLeadView, loadLeadViews } from "./lead-party-reader";

export type MergeLoserResult =
  | { ok: true }
  | { ok: false; reason: "self" | "keep_not_found" | "merge_not_found" };

@Injectable()
export class LeadsDetailService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly dispatch: NotificationDispatchService,
    private readonly notificationAi: LeadNotificationAiService,
  ) {}

  private async sendAssignmentEmail(actorId: string, lead: LeadRow): Promise<void> {
    if (!lead.assignedToId) return;
    await this.dispatch.emit({
      eventKey: "crm.lead.assigned",
      orgId: lead.orgId,
      actorUserId: actorId,
      targetUserIds: [lead.assignedToId],
      entityType: "lead",
      entityId: String(lead.id),
      title: "Lead assigned to you",
      message: `You have been assigned lead: ${lead.name}`,
      link: `/crm/leads/${lead.id}`,
      variables: { leadName: lead.name, source: lead.source, priority: lead.priority },
    });
  }

  getActivities(orgId: string, leadId: number, limit: number) {
    return this.db.query.leadActivities.findMany({
      where: and(eq(leadActivities.leadId, leadId), eq(leadActivities.orgId, orgId)),
      with: { user: { columns: { id: true, name: true, image: true } } },
      orderBy: [desc(leadActivities.date)],
      limit,
    });
  }

  async getTimeline(orgId: string, leadId: number, limit: number) {
    const [notes, tasks, emails, activities] = await Promise.all([
      this.db.query.leadNotes.findMany({
        where: and(eq(leadNotes.leadId, leadId), eq(leadNotes.orgId, orgId)),
        with: { author: { columns: { id: true, name: true } } },
        orderBy: desc(leadNotes.createdAt),
        limit,
      }),
      this.db.query.leadTasks.findMany({
        where: and(eq(leadTasks.leadId, leadId), eq(leadTasks.orgId, orgId)),
        orderBy: desc(leadTasks.createdAt),
        limit,
      }),
      this.db
        .select()
        .from(leadEmails)
        .where(and(eq(leadEmails.leadId, leadId), eq(leadEmails.orgId, orgId)))
        .orderBy(desc(leadEmails.sentAt))
        .limit(limit),
      this.db
        .select()
        .from(leadActivities)
        .where(and(eq(leadActivities.leadId, leadId), eq(leadActivities.orgId, orgId)))
        .orderBy(desc(leadActivities.createdAt))
        .limit(limit),
    ]);

    const timeline = [
      ...notes.map((n) => ({ id: n.id, type: "note" as const, timestamp: n.createdAt, data: n })),
      ...tasks.map((t) => ({ id: t.id, type: "task" as const, timestamp: t.createdAt, data: t })),
      ...emails.map((e) => ({ id: e.id, type: "email" as const, timestamp: e.sentAt, data: e })),
      ...activities.map((a) => ({ id: a.id, type: "activity" as const, timestamp: a.createdAt, data: a })),
    ];

    timeline.sort((a, b) => {
      const aTime = a.timestamp ? new Date(a.timestamp).getTime() : 0;
      const bTime = b.timestamp ? new Date(b.timestamp).getTime() : 0;
      return bTime - aTime;
    });

    return timeline.slice(0, limit);
  }

  async getScoreExplanation(orgId: string, leadId: number) {
    // The whole row, in `leads`' vocabulary: a scoring rule stores the field name
    // a tenant picked (`score`, `city`, `status`), and the rule loop below looks
    // it up by that name.
    const lead = await loadLeadView(this.db, orgId, leadId);

    if (!lead) return null;

    const rules = await this.db
      .select()
      .from(leadScoringRules)
      .where(eq(leadScoringRules.orgId, orgId));

    const leadRecord: Record<string, unknown> = { ...lead };
    const firedRules: { name: string; field: string; operator: string; value: string; points: number; dimension: string }[] = [];
    const dimensionBreakdown: Record<string, number> = {};
    let total = 0;

    for (const rule of rules) {
      const fieldValue = leadRecord[rule.field];
      if (fieldValue === undefined || fieldValue === null) continue;

      const strValue = String(fieldValue);
      let match = false;

      switch (rule.operator) {
        case "eq":
          match = strValue === rule.value;
          break;
        case "gt":
          match = Number(strValue) > Number(rule.value);
          break;
        case "lt":
          match = Number(strValue) < Number(rule.value);
          break;
        case "contains":
          match = strValue.toLowerCase().includes(rule.value.toLowerCase());
          break;
        case "in":
          match = rule.value.split(",").map((v) => v.trim()).includes(strValue);
          break;
      }

      if (match) {
        const dim = rule.dimension ?? "fit";
        firedRules.push({
          name: `${rule.field} ${rule.operator} ${rule.value}`,
          field: rule.field,
          operator: rule.operator,
          value: rule.value,
          points: rule.points,
          dimension: dim,
        });
        dimensionBreakdown[dim] = (dimensionBreakdown[dim] ?? 0) + rule.points;
        total += rule.points;
      }
    }

    total = Math.max(0, Math.min(100, total));
    return { score: total, firedRules, totalRules: rules.length, dimensionBreakdown };
  }

  async addActivity(orgId: string, userId: string, leadId: number, input: LogActivityInput) {
    const lead = await loadLeadView(this.db, orgId, leadId);
    if (!lead) throw new NotFoundException("Lead not found");

    const [activity] = await this.db
      .insert(leadActivities)
      .values({
        orgId,
        leadId,
        type: input.type,
        date: new Date(input.date),
        duration: input.duration,
        subject: input.subject,
        location: input.location,
        locationLink: input.locationLink,
        messageSummary: input.messageSummary,
        notes: input.notes,
        outcome: input.outcome,
        userId,
      })
      .returning();

    return activity;
  }

  async updateCustomData(orgId: string, leadId: number, input: CustomDataInput) {
    const existing = await loadLeadView(this.db, orgId, leadId);

    if (!existing) return null;

    const [updated] = await updateMirroredLeads(this.db, orgId, [leadId], {
      customData: input.customData,
      updatedAt: new Date(),
    });

    return { customData: updated?.customData ?? null };
  }

  async verify(orgId: string, userId: string, leadId: number, input: VerifyInput) {
    const updateData: Partial<LeadInsert> = {
      verifiedById: userId,
      updatedAt: new Date(),
    };
    if (input.priority) updateData.priority = input.priority;
    if (input.notes) updateData.notes = input.notes;

    const [updated] = await updateMirroredLeads(this.db, orgId, [leadId], updateData);

    return updated ?? null;
  }

  async reject(orgId: string, userId: string, leadId: number, input: RejectInput) {
    const [updated] = await updateMirroredLeads(this.db, orgId, [leadId], {
      status: "LOST",
      lostReason: input.reason || "Rejected during review",
      verifiedById: userId,
      updatedAt: new Date(),
    });

    return updated ?? null;
  }

  async selfAssign(orgId: string, userId: string, leadId: number) {
    const [updated] = await updateMirroredLeads(this.db, orgId, [leadId], {
      assignedToId: userId,
      assignedById: userId,
      assignedAt: new Date(),
      updatedAt: new Date(),
    });

    return updated ?? null;
  }

  async assign(orgId: string, userId: string, leadId: number, input: AssignInput) {
    const [updated] = await updateMirroredLeads(this.db, orgId, [leadId], {
      assignedToId: input.assignedToId,
      assignedById: userId,
      assignedAt: new Date(),
      updatedAt: new Date(),
    });

    if (!updated) return null;

    this.audit.log({
      action: "lead.assigned",
      userId,
      orgId,
      targetId: String(leadId),
      targetType: "lead",
      metadata: {
        previousAssignee: updated.assignedToId,
        newAssignee: input.assignedToId,
        leadName: updated.name,
      },
    });

    const notification = await this.notifications.create({
      orgId,
      userId: input.assignedToId,
      type: "INFO",
      title: "Lead Assigned to You",
      message: `You have been assigned lead: ${updated.name}`,
      link: `/crm/leads/${updated.id}`,
    });

    void this.sendAssignmentEmail(userId, updated).catch(logSideEffectFailure("lead assignment email", { orgId, leadId: updated.id }));

    if (notification) {
      void this.enrichAssignmentNotification(
        orgId,
        notification.id,
        input.assignedToId,
        updated,
      ).catch(logSideEffectFailure("lead assignment notification enrichment", { orgId, notificationId: notification.id }));
    }

    return updated;
  }

  private async enrichAssignmentNotification(
    orgId: string,
    notificationId: number,
    recipientId: string,
    lead: LeadRow,
  ): Promise<void> {
    const result = await this.notificationAi.generateSmartNotification({
      event: "LEAD_ASSIGNED",
      defaultTitle: "Lead Assigned to You",
      defaultMessage: `You have been assigned lead: ${lead.name}`,
      orgId,
      context: {
        leadName: lead.name,
        priority: lead.priority ?? undefined,
        source: lead.source ?? undefined,
        company: lead.company ?? undefined,
        potentialValue: lead.potentialValue ?? undefined,
        notes: lead.notes ?? undefined,
      },
    });

    if (!result.enriched) return;

    await this.db
      .update(notifications)
      .set({ title: result.title, message: result.message })
      .where(
        and(
          eq(notifications.id, notificationId),
          eq(notifications.orgId, orgId),
          eq(notifications.userId, recipientId),
        ),
      );
  }

  async mergeLoser(orgId: string, keepLeadId: number, mergeLeadId: number): Promise<MergeLoserResult> {
    if (mergeLeadId === keepLeadId) {
      return { ok: false, reason: "self" };
    }

    // Both in one read: two round trips answered one question, and the answer
    // for the second was only ever used to reject the whole request.
    const live = new Set(
      (await loadLeadViews(this.db, orgId, [keepLeadId, mergeLeadId])).map((lead) => lead.id),
    );

    if (!live.has(keepLeadId)) return { ok: false, reason: "keep_not_found" };
    if (!live.has(mergeLeadId)) return { ok: false, reason: "merge_not_found" };

    await updateMirroredLeads(this.db, orgId, [mergeLeadId], {
      status: "LOST",
      lostReason: `Merged with lead #${keepLeadId}`,
      notes: `Merged with lead #${keepLeadId} — this record is a duplicate.`,
      updatedAt: new Date(),
    });

    return { ok: true };
  }
}
