import { Inject, Injectable } from "@nestjs/common";
import { eq, and, desc, inArray } from "drizzle-orm";
import {
  leads,
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
import { EmailService } from "../email/email.service";
import { NotificationsService } from "../notifications/notifications.service";
import { LeadNotificationAiService } from "./lead-notification-ai.service";
import type {
  AssignInput,
  CustomDataInput,
  LogActivityInput,
  RejectInput,
  VerifyInput,
} from "./dto/lead-mutations.schemas";

type LeadRow = typeof leads.$inferSelect;

export type MergeLoserResult =
  | { ok: true }
  | { ok: false; reason: "self" | "keep_not_found" | "merge_not_found" };

@Injectable()
export class LeadsDetailService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly email: EmailService,
    private readonly notificationAi: LeadNotificationAiService,
  ) {}

  private async sendAssignmentEmail(actorId: string, lead: LeadRow): Promise<void> {
    if (!lead.assignedToId) return;
    const ids = Array.from(new Set([lead.assignedToId, actorId]));
    const people = await this.db
      .select({ id: users.id, email: users.email, name: users.name })
      .from(users)
      .where(inArray(users.id, ids));

    const assignee = people.find((p) => p.id === lead.assignedToId);
    if (!assignee?.email) return;

    const assigner = people.find((p) => p.id === actorId);
    await this.email.sendLeadAssignedEmail(
      assignee.email,
      assignee.name ?? "Team Member",
      lead.name,
      lead.source,
      lead.priority,
      assigner?.name ?? "A manager",
    );
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
    const [lead] = await this.db
      .select()
      .from(leads)
      .where(and(eq(leads.id, leadId), eq(leads.orgId, orgId)));

    if (!lead) return null;

    const rules = await this.db
      .select()
      .from(leadScoringRules)
      .where(eq(leadScoringRules.orgId, orgId));

    const leadRecord: Record<string, unknown> = { ...lead };
    const firedRules: { name: string; field: string; operator: string; value: string; points: number }[] = [];
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
        firedRules.push({
          name: `${rule.field} ${rule.operator} ${rule.value}`,
          field: rule.field,
          operator: rule.operator,
          value: rule.value,
          points: rule.points,
        });
        total += rule.points;
      }
    }

    total = Math.max(0, Math.min(100, total));
    return { score: total, firedRules, totalRules: rules.length };
  }

  async addActivity(orgId: string, userId: string, leadId: number, input: LogActivityInput) {
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
    const [existing] = await this.db
      .select({ id: leads.id })
      .from(leads)
      .where(and(eq(leads.id, leadId), eq(leads.orgId, orgId)))
      .limit(1);

    if (!existing) return null;

    const [updated] = await this.db
      .update(leads)
      .set({ customData: input.customData, updatedAt: new Date() })
      .where(and(eq(leads.id, leadId), eq(leads.orgId, orgId)))
      .returning();

    return { customData: updated.customData };
  }

  async verify(orgId: string, userId: string, leadId: number, input: VerifyInput) {
    const updateData: Partial<typeof leads.$inferInsert> = {
      verifiedById: userId,
      updatedAt: new Date(),
    };
    if (input.priority) updateData.priority = input.priority;
    if (input.notes) updateData.notes = input.notes;

    const [updated] = await this.db
      .update(leads)
      .set(updateData)
      .where(and(eq(leads.id, leadId), eq(leads.orgId, orgId)))
      .returning();

    return updated ?? null;
  }

  async reject(orgId: string, userId: string, leadId: number, input: RejectInput) {
    const [updated] = await this.db
      .update(leads)
      .set({
        status: "LOST",
        lostReason: input.reason || "Rejected during review",
        verifiedById: userId,
        updatedAt: new Date(),
      })
      .where(and(eq(leads.id, leadId), eq(leads.orgId, orgId)))
      .returning();

    return updated ?? null;
  }

  async selfAssign(orgId: string, userId: string, leadId: number) {
    const [updated] = await this.db
      .update(leads)
      .set({
        assignedToId: userId,
        assignedById: userId,
        assignedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(leads.id, leadId), eq(leads.orgId, orgId)))
      .returning();

    return updated ?? null;
  }

  async assign(orgId: string, userId: string, leadId: number, input: AssignInput) {
    const [updated] = await this.db
      .update(leads)
      .set({
        assignedToId: input.assignedToId,
        assignedById: userId,
        assignedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(leads.id, leadId), eq(leads.orgId, orgId)))
      .returning();

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

    void this.sendAssignmentEmail(userId, updated).catch(() => undefined);

    if (notification) {
      void this.enrichAssignmentNotification(
        orgId,
        notification.id,
        input.assignedToId,
        updated,
      ).catch(() => undefined);
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

    const [keepLead] = await this.db
      .select({ id: leads.id })
      .from(leads)
      .where(and(eq(leads.id, keepLeadId), eq(leads.orgId, orgId)));

    if (!keepLead) return { ok: false, reason: "keep_not_found" };

    const [mergeLead] = await this.db
      .select({ id: leads.id })
      .from(leads)
      .where(and(eq(leads.id, mergeLeadId), eq(leads.orgId, orgId)));

    if (!mergeLead) return { ok: false, reason: "merge_not_found" };

    await this.db
      .update(leads)
      .set({
        status: "LOST",
        lostReason: `Merged with lead #${keepLeadId}`,
        notes: `Merged with lead #${keepLeadId} — this record is a duplicate.`,
        updatedAt: new Date(),
      })
      .where(and(eq(leads.id, mergeLeadId), eq(leads.orgId, orgId)));

    return { ok: true };
  }
}
