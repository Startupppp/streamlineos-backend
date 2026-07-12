import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, lt, lte, gte, sql, desc, isNull, not, inArray, isNotNull } from "drizzle-orm";
import { tasks, leads, leadEmails, deals, dealMeetings, users, crmOptions, crmPipelineStages, quotes } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import type { DataScope } from "../access/access.types";
import { applyScope } from "../access/apply-scope";
import type { SnoozeTaskInput } from "./crm-inbox.dto";
import { resolveLeadStatusSemantics } from "../leads/lead-status-semantics";

interface AiAction {
  type: string;
  entityType: "lead" | "deal" | "quote";
  entityId: number;
  title: string;
  reason: string;
  href: string;
}

interface InboxItem {
  id: number;
  type: string;
  title: string;
  entityType: "lead" | "deal" | "task";
  entityId: number;
  dueAt: string | null;
  assigneeName: string | null;
  assigneeId: string | null;
  meta: Record<string, unknown>;
}

interface InboxSection {
  key: string;
  items: InboxItem[];
  total: number;
}

interface InboxResponse {
  sections: InboxSection[];
  aiActions: AiAction[];
}

interface InboxCounts {
  dueTasks: number;
  overdueTasks: number;
  slaRisk: number;
  stuckDeals: number;
  followUpsDue: number;
  newReplies: number;
  meetingsToday: number;
  newlyAssigned: number;
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function endOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}

@Injectable()
export class CrmInboxService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  private async resolveMetadata(orgId: string): Promise<{ terminalLeadKeys: string[]; openStageKeys: string[] }> {
    const [leadStatusOptions, pipelineStageRows] = await Promise.all([
      this.db
        .select({ key: crmOptions.key, isTerminal: crmOptions.isTerminal, metadata: crmOptions.metadata })
        .from(crmOptions)
        .where(and(eq(crmOptions.orgId, orgId), eq(crmOptions.type, "lead_status"), eq(crmOptions.isActive, true))),
      this.db
        .select({ key: crmPipelineStages.key })
        .from(crmPipelineStages)
        .where(and(eq(crmPipelineStages.orgId, orgId), eq(crmPipelineStages.isActive, true), eq(crmPipelineStages.isTerminal, false))),
    ]);

    const semantics = resolveLeadStatusSemantics(
      leadStatusOptions.map((o) => ({
        key: o.key,
        isTerminal: o.isTerminal ?? false,
        metadata: (o.metadata as Record<string, unknown> | null) ?? null,
      })),
    );

    const terminalLeadKeys = [...semantics.convertedKeys, ...semantics.lostKeys];
    const openStageKeys = pipelineStageRows.map((r) => r.key);

    return { terminalLeadKeys, openStageKeys };
  }

  private async computeAiActions(
    orgId: string,
    userId: string,
    scope: DataScope,
    terminalLeadKeys: string[],
    openStageKeys: string[],
  ): Promise<AiAction[]> {
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const todayString = now.toISOString().slice(0, 10);
    const threeDaysFromNow = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const leadScopeFilter = applyScope(scope, userId, { ownerColumn: leads.assignedToId });

    const [hotLeads, slaDeals, expiringQuotes] = await Promise.all([
      this.db
        .select({ id: leads.id, name: leads.name })
        .from(leads)
        .where(
          and(
            eq(leads.orgId, orgId),
            not(inArray(leads.status, terminalLeadKeys)),
            isNull(leads.deletedAt),
            lte(leads.updatedAt, sevenDaysAgo),
            leadScopeFilter,
          ),
        )
        .orderBy(leads.followUpDate)
        .limit(3),

      openStageKeys.length > 0
        ? this.db
            .select({ id: deals.id, name: deals.name })
            .from(deals)
            .where(
              and(
                eq(deals.orgId, orgId),
                inArray(deals.stage, openStageKeys),
                isNotNull(deals.slaDeadline),
                lt(deals.slaDeadline, now),
              ),
            )
            .limit(3)
        : Promise.resolve([] as { id: number; name: string }[]),

      this.db
        .select({ id: quotes.id, quoteNumber: quotes.quoteNumber, dealId: quotes.dealId })
        .from(quotes)
        .where(
          and(
            eq(quotes.orgId, orgId),
            inArray(quotes.status, ["SENT", "DRAFT"]),
            lte(quotes.validUntil, threeDaysFromNow),
            gte(quotes.validUntil, todayString),
          ),
        )
        .limit(4),
    ]);

    const actions: AiAction[] = [
      ...hotLeads.map(
        (l): AiAction => ({
          type: "call_lead",
          entityType: "lead",
          entityId: l.id,
          title: "Follow up with " + l.name,
          reason: "No contact in 7+ days",
          href: "/crm/leads/" + String(l.id),
        }),
      ),
      ...slaDeals.map(
        (d): AiAction => ({
          type: "advance_deal",
          entityType: "deal",
          entityId: d.id,
          title: "Advance or update " + d.name,
          reason: "Past SLA deadline",
          href: "/crm/deals/" + String(d.id),
        }),
      ),
      ...expiringQuotes.map(
        (q): AiAction => ({
          type: "follow_up_quote",
          entityType: "quote",
          entityId: q.id,
          title: "Follow up on quote " + q.quoteNumber,
          reason: "Quote expiring in ≤3 days",
          href: q.dealId != null ? "/crm/deals/" + String(q.dealId) : "/crm/quotes/" + String(q.id),
        }),
      ),
    ];

    return actions.slice(0, 10);
  }

  async getInbox(orgId: string, userId: string, scope: DataScope): Promise<InboxResponse> {
    const now = new Date();
    const todayStart = startOfDay(now);
    const todayEnd = endOfDay(now);
    const fortyEightHoursAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000);
    const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
    const fourHoursFromNow = new Date(now.getTime() + 4 * 60 * 60 * 1000);

    const scopeFilter = applyScope(scope, userId, { ownerColumn: tasks.assigneeId });
    const leadScopeFilter = applyScope(scope, userId, { ownerColumn: leads.assignedToId });

    const { terminalLeadKeys, openStageKeys } = await this.resolveMetadata(orgId);

    const [
      dueTasks,
      overdueTasks,
      followUpsDue,
      newReplies,
      meetingsToday,
      slaRisk,
      stuckDeals,
      newlyAssigned,
      aiActions,
    ] = await Promise.all([
      this.db
        .select({
          id: tasks.id,
          title: tasks.title,
          dueDate: tasks.dueDate,
          assigneeId: tasks.assigneeId,
          entityType: tasks.entityType,
          entityId: tasks.entityId,
          type: tasks.type,
        })
        .from(tasks)
        .where(
          and(
            eq(tasks.orgId, orgId),
            eq(tasks.status, "pending"),
            gte(tasks.dueDate, todayStart),
            lte(tasks.dueDate, todayEnd),
            isNull(tasks.snoozedUntil),
            scopeFilter,
          ),
        )
        .orderBy(tasks.dueDate)
        .limit(10),

      this.db
        .select({
          id: tasks.id,
          title: tasks.title,
          dueDate: tasks.dueDate,
          assigneeId: tasks.assigneeId,
          entityType: tasks.entityType,
          entityId: tasks.entityId,
          type: tasks.type,
        })
        .from(tasks)
        .where(
          and(
            eq(tasks.orgId, orgId),
            eq(tasks.status, "pending"),
            lt(tasks.dueDate, todayStart),
            isNull(tasks.snoozedUntil),
            scopeFilter,
          ),
        )
        .orderBy(tasks.dueDate)
        .limit(10),

      this.db
        .select({
          id: leads.id,
          name: leads.name,
          followUpDate: leads.followUpDate,
          assignedToId: leads.assignedToId,
          status: leads.status,
        })
        .from(leads)
        .where(
          and(
            eq(leads.orgId, orgId),
            not(inArray(leads.status, terminalLeadKeys)),
            lte(leads.followUpDate, now),
            isNull(leads.deletedAt),
            leadScopeFilter,
          ),
        )
        .orderBy(leads.followUpDate)
        .limit(10),

      this.db
        .select({
          id: leadEmails.id,
          leadId: leadEmails.leadId,
          subject: leadEmails.subject,
          sentAt: leadEmails.sentAt,
          fromEmail: leadEmails.fromEmail,
        })
        .from(leadEmails)
        .where(
          and(
            eq(leadEmails.orgId, orgId),
            eq(leadEmails.direction, "received"),
            gte(leadEmails.sentAt, fortyEightHoursAgo),
          ),
        )
        .orderBy(desc(leadEmails.sentAt))
        .limit(10),

      this.db
        .select({
          id: dealMeetings.id,
          title: dealMeetings.title,
          scheduledAt: dealMeetings.scheduledAt,
          dealId: dealMeetings.dealId,
        })
        .from(dealMeetings)
        .where(
          and(
            eq(dealMeetings.orgId, orgId),
            eq(dealMeetings.status, "scheduled"),
            gte(dealMeetings.scheduledAt, todayStart),
            lte(dealMeetings.scheduledAt, todayEnd),
          ),
        )
        .orderBy(dealMeetings.scheduledAt)
        .limit(10),

      this.db
        .select({
          id: leads.id,
          name: leads.name,
          slaDeadline: leads.slaDeadline,
          assignedToId: leads.assignedToId,
          status: leads.status,
        })
        .from(leads)
        .where(
          and(
            eq(leads.orgId, orgId),
            not(inArray(leads.status, terminalLeadKeys)),
            lte(leads.slaDeadline, fourHoursFromNow),
            isNull(leads.deletedAt),
            leadScopeFilter,
          ),
        )
        .orderBy(leads.slaDeadline)
        .limit(10),

      openStageKeys.length > 0
        ? this.db
            .select({
              id: deals.id,
              name: deals.name,
              stage: deals.stage,
              assignedToId: deals.assignedToId,
            })
            .from(deals)
            .where(
              and(
                eq(deals.orgId, orgId),
                inArray(deals.stage, openStageKeys),
                not(
                  sql`EXISTS (
                    SELECT 1 FROM deal_activities da
                    WHERE da.deal_id = ${deals.id}
                    AND da.created_at >= ${fourteenDaysAgo}
                  )`,
                ),
              ),
            )
            .limit(10)
        : Promise.resolve([] as { id: number; name: string; stage: string; assignedToId: string | null }[]),

      this.db
        .select({
          id: leads.id,
          name: leads.name,
          assignedAt: leads.assignedAt,
          assignedToId: leads.assignedToId,
          status: leads.status,
        })
        .from(leads)
        .where(
          and(
            eq(leads.orgId, orgId),
            eq(leads.assignedToId, userId),
            gte(leads.assignedAt, fortyEightHoursAgo),
            not(inArray(leads.status, terminalLeadKeys)),
            isNull(leads.deletedAt),
          ),
        )
        .orderBy(desc(leads.assignedAt))
        .limit(10),

      this.computeAiActions(orgId, userId, scope, terminalLeadKeys, openStageKeys),
    ]);

    return {
      sections: [
        {
          key: "dueTasks",
          items: dueTasks.map((t) => ({
            id: t.id,
            type: t.type ?? "CUSTOM",
            title: t.title,
            entityType: "task" as const,
            entityId: t.id,
            dueAt: t.dueDate?.toISOString() ?? null,
            assigneeName: null,
            assigneeId: t.assigneeId,
            meta: { entityType: t.entityType, entityId: t.entityId },
          })),
          total: dueTasks.length,
        },
        {
          key: "overdueTasks",
          items: overdueTasks.map((t) => ({
            id: t.id,
            type: t.type ?? "CUSTOM",
            title: t.title,
            entityType: "task" as const,
            entityId: t.id,
            dueAt: t.dueDate?.toISOString() ?? null,
            assigneeName: null,
            assigneeId: t.assigneeId,
            meta: { entityType: t.entityType, entityId: t.entityId },
          })),
          total: overdueTasks.length,
        },
        {
          key: "followUpsDue",
          items: followUpsDue.map((l) => ({
            id: l.id,
            type: "follow_up",
            title: l.name,
            entityType: "lead" as const,
            entityId: l.id,
            dueAt: l.followUpDate?.toISOString() ?? null,
            assigneeName: null,
            assigneeId: l.assignedToId,
            meta: { status: l.status },
          })),
          total: followUpsDue.length,
        },
        {
          key: "newReplies",
          items: newReplies.map((e) => ({
            id: e.id,
            type: "email_reply",
            title: e.subject ?? "New reply",
            entityType: "lead" as const,
            entityId: e.leadId,
            dueAt: e.sentAt.toISOString(),
            assigneeName: null,
            assigneeId: null,
            meta: { fromEmail: e.fromEmail },
          })),
          total: newReplies.length,
        },
        {
          key: "meetingsToday",
          items: meetingsToday.map((m) => ({
            id: m.id,
            type: "meeting",
            title: m.title,
            entityType: "deal" as const,
            entityId: m.dealId,
            dueAt: m.scheduledAt.toISOString(),
            assigneeName: null,
            assigneeId: null,
            meta: {},
          })),
          total: meetingsToday.length,
        },
        {
          key: "slaRisk",
          items: slaRisk.map((l) => ({
            id: l.id,
            type: "sla_risk",
            title: l.name,
            entityType: "lead" as const,
            entityId: l.id,
            dueAt: l.slaDeadline?.toISOString() ?? null,
            assigneeName: null,
            assigneeId: l.assignedToId,
            meta: { status: l.status, breached: l.slaDeadline != null && l.slaDeadline < now },
          })),
          total: slaRisk.length,
        },
        {
          key: "stuckDeals",
          items: stuckDeals.map((d) => ({
            id: d.id,
            type: "stuck_deal",
            title: d.name,
            entityType: "deal" as const,
            entityId: d.id,
            dueAt: null,
            assigneeName: null,
            assigneeId: d.assignedToId,
            meta: { stage: d.stage },
          })),
          total: stuckDeals.length,
        },
        {
          key: "newlyAssigned",
          items: newlyAssigned.map((l) => ({
            id: l.id,
            type: "newly_assigned",
            title: l.name,
            entityType: "lead" as const,
            entityId: l.id,
            dueAt: l.assignedAt?.toISOString() ?? null,
            assigneeName: null,
            assigneeId: l.assignedToId,
            meta: { status: l.status },
          })),
          total: newlyAssigned.length,
        },
      ],
      aiActions,
    };
  }

  async getCounts(orgId: string, userId: string, scope: DataScope): Promise<InboxCounts> {
    const now = new Date();
    const todayStart = startOfDay(now);
    const todayEnd = endOfDay(now);
    const fortyEightHoursAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000);
    const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
    const fourHoursFromNow = new Date(now.getTime() + 4 * 60 * 60 * 1000);

    const scopeFilter = applyScope(scope, userId, { ownerColumn: tasks.assigneeId });
    const leadScopeFilter = applyScope(scope, userId, { ownerColumn: leads.assignedToId });

    const { terminalLeadKeys, openStageKeys } = await this.resolveMetadata(orgId);

    const [
      dueTasksCount,
      overdueTasksCount,
      followUpsDueCount,
      newRepliesCount,
      meetingsTodayCount,
      slaRiskCount,
      stuckDealsCount,
      newlyAssignedCount,
    ] = await Promise.all([
      this.db
        .select({ n: sql<number>`count(*)` })
        .from(tasks)
        .where(and(eq(tasks.orgId, orgId), eq(tasks.status, "pending"), gte(tasks.dueDate, todayStart), lte(tasks.dueDate, todayEnd), isNull(tasks.snoozedUntil), scopeFilter))
        .then((r) => Number(r[0]?.n ?? 0)),
      this.db
        .select({ n: sql<number>`count(*)` })
        .from(tasks)
        .where(and(eq(tasks.orgId, orgId), eq(tasks.status, "pending"), lt(tasks.dueDate, todayStart), isNull(tasks.snoozedUntil), scopeFilter))
        .then((r) => Number(r[0]?.n ?? 0)),
      this.db
        .select({ n: sql<number>`count(*)` })
        .from(leads)
        .where(and(eq(leads.orgId, orgId), not(inArray(leads.status, terminalLeadKeys)), lte(leads.followUpDate, now), isNull(leads.deletedAt), leadScopeFilter))
        .then((r) => Number(r[0]?.n ?? 0)),
      this.db
        .select({ n: sql<number>`count(*)` })
        .from(leadEmails)
        .where(and(eq(leadEmails.orgId, orgId), eq(leadEmails.direction, "received"), gte(leadEmails.sentAt, fortyEightHoursAgo)))
        .then((r) => Number(r[0]?.n ?? 0)),
      this.db
        .select({ n: sql<number>`count(*)` })
        .from(dealMeetings)
        .where(and(eq(dealMeetings.orgId, orgId), eq(dealMeetings.status, "scheduled"), gte(dealMeetings.scheduledAt, todayStart), lte(dealMeetings.scheduledAt, todayEnd)))
        .then((r) => Number(r[0]?.n ?? 0)),
      this.db
        .select({ n: sql<number>`count(*)` })
        .from(leads)
        .where(and(eq(leads.orgId, orgId), not(inArray(leads.status, terminalLeadKeys)), lte(leads.slaDeadline, fourHoursFromNow), isNull(leads.deletedAt), leadScopeFilter))
        .then((r) => Number(r[0]?.n ?? 0)),
      openStageKeys.length > 0
        ? this.db
            .select({ n: sql<number>`count(*)` })
            .from(deals)
            .where(and(eq(deals.orgId, orgId), inArray(deals.stage, openStageKeys), not(sql`EXISTS (SELECT 1 FROM deal_activities da WHERE da.deal_id = ${deals.id} AND da.created_at >= ${fourteenDaysAgo})`)))
            .then((r) => Number(r[0]?.n ?? 0))
        : Promise.resolve(0),
      this.db
        .select({ n: sql<number>`count(*)` })
        .from(leads)
        .where(and(eq(leads.orgId, orgId), eq(leads.assignedToId, userId), gte(leads.assignedAt, fortyEightHoursAgo), not(inArray(leads.status, terminalLeadKeys)), isNull(leads.deletedAt)))
        .then((r) => Number(r[0]?.n ?? 0)),
    ]);

    return {
      dueTasks: dueTasksCount,
      overdueTasks: overdueTasksCount,
      followUpsDue: followUpsDueCount,
      newReplies: newRepliesCount,
      meetingsToday: meetingsTodayCount,
      slaRisk: slaRiskCount,
      stuckDeals: stuckDealsCount,
      newlyAssigned: newlyAssignedCount,
    };
  }

  async snoozeTask(orgId: string, taskId: number, userId: string, input: SnoozeTaskInput): Promise<void> {
    const [task] = await this.db
      .select({ id: tasks.id, orgId: tasks.orgId, assigneeId: tasks.assigneeId })
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.orgId, orgId)))
      .limit(1);

    if (!task) throw new NotFoundException("Task not found");

    await this.db
      .update(tasks)
      .set({ snoozedUntil: new Date(input.until), updatedAt: new Date() })
      .where(and(eq(tasks.id, taskId), eq(tasks.orgId, orgId)));
  }

  async completeTask(orgId: string, taskId: number, userId: string): Promise<void> {
    const [task] = await this.db
      .select({ id: tasks.id, orgId: tasks.orgId })
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.orgId, orgId)))
      .limit(1);

    if (!task) throw new NotFoundException("Task not found");

    await this.db
      .update(tasks)
      .set({ status: "completed", completedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(tasks.id, taskId), eq(tasks.orgId, orgId)));
  }
}
