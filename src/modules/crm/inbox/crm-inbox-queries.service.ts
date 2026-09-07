import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gte, inArray, isNull, lt, lte, not, sql } from "drizzle-orm";
import { tasks, leadEmails, deals, dealMeetings } from "../../../db/schema";
import { businessParties, leadPartyMap } from "../../../db/schema/party";
import { PARTY_OF_LEAD, leadStatus } from "../crm-party-reads";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import type { DataScope } from "../../access/access.types";
import { applyScope } from "../../access/apply-scope";
import { CrmInboxAiActionsService, type AiAction } from "./crm-inbox-ai-actions.service";

export interface InboxItem {
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

export interface InboxSection {
  key: string;
  items: InboxItem[];
  total: number;
}

export interface InboxResponse {
  sections: InboxSection[];
  aiActions: AiAction[];
}

export interface InboxCounts {
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

const INBOX_REPLY_LOOKBACK_MS = 48 * 60 * 60 * 1000;
const INBOX_ACTIVITY_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;
const INBOX_SLA_HORIZON_MS = 4 * 60 * 60 * 1000;

@Injectable()
export class CrmInboxQueriesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly aiActions: CrmInboxAiActionsService,
  ) {}

  async getInbox(orgId: string, userId: string, scope: DataScope): Promise<InboxResponse> {
    const now = new Date();
    const todayStart = startOfDay(now);
    const todayEnd = endOfDay(now);
    const fortyEightHoursAgo = new Date(now.getTime() - INBOX_REPLY_LOOKBACK_MS);
    const fourteenDaysAgo = new Date(now.getTime() - INBOX_ACTIVITY_LOOKBACK_MS);
    const fourHoursFromNow = new Date(now.getTime() + INBOX_SLA_HORIZON_MS);

    const scopeFilter = applyScope(scope, orgId, userId, { ownerColumn: tasks.assigneeId });
    const leadScopeFilter = applyScope(scope, orgId, userId, { ownerColumn: businessParties.ownerUserId });

    const { terminalLeadKeys, openStageKeys } = await this.aiActions.resolveMetadata(orgId);

    const [
      dueTasks,
      overdueTasks,
      followUpsDue,
      newReplies,
      meetingsToday,
      slaRisk,
      stuckDeals,
      newlyAssigned,
      aiActionsResult,
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
        .where(and(eq(tasks.orgId, orgId), eq(tasks.status, "pending"), gte(tasks.dueDate, todayStart), lte(tasks.dueDate, todayEnd), isNull(tasks.snoozedUntil), scopeFilter))
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
        .where(and(eq(tasks.orgId, orgId), eq(tasks.status, "pending"), lt(tasks.dueDate, todayStart), isNull(tasks.snoozedUntil), scopeFilter))
        .orderBy(tasks.dueDate)
        .limit(10),

      this.db
        .select({
          id: leadPartyMap.leadId,
          name: businessParties.name,
          followUpDate: businessParties.nextFollowUpAt,
          assignedToId: businessParties.ownerUserId,
          status: leadStatus,
        })
        .from(leadPartyMap)
        .innerJoin(businessParties, PARTY_OF_LEAD)
        .where(and(eq(leadPartyMap.organizationId, orgId), not(inArray(leadStatus, terminalLeadKeys)), lte(businessParties.nextFollowUpAt, now), isNull(businessParties.deletedAt), leadScopeFilter))
        .orderBy(businessParties.nextFollowUpAt)
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
        .where(and(eq(leadEmails.orgId, orgId), eq(leadEmails.direction, "received"), gte(leadEmails.sentAt, fortyEightHoursAgo)))
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
        .where(and(eq(dealMeetings.orgId, orgId), eq(dealMeetings.status, "scheduled"), gte(dealMeetings.scheduledAt, todayStart), lte(dealMeetings.scheduledAt, todayEnd)))
        .orderBy(dealMeetings.scheduledAt)
        .limit(10),

      this.db
        .select({
          id: leadPartyMap.leadId,
          name: businessParties.name,
          slaDeadline: businessParties.slaDueAt,
          assignedToId: businessParties.ownerUserId,
          status: leadStatus,
        })
        .from(leadPartyMap)
        .innerJoin(businessParties, PARTY_OF_LEAD)
        .where(and(eq(leadPartyMap.organizationId, orgId), not(inArray(leadStatus, terminalLeadKeys)), lte(businessParties.slaDueAt, fourHoursFromNow), isNull(businessParties.deletedAt), leadScopeFilter))
        .orderBy(businessParties.slaDueAt)
        .limit(10),

      openStageKeys.length > 0
        ? this.db
            .select({ id: deals.id, name: deals.name, stage: deals.stage, assignedToId: deals.assignedToId })
            .from(deals)
            .where(and(eq(deals.orgId, orgId), isNull(deals.deletedAt), inArray(deals.stage, openStageKeys), not(sql`EXISTS (SELECT 1 FROM deal_activities da WHERE da.deal_id = ${deals.id} AND da.created_at >= ${fourteenDaysAgo.toISOString()})`)))
            .limit(10)
        : Promise.resolve<{ id: number; name: string; stage: string; assignedToId: string | null }[]>([]),

      this.db
        .select({
          id: leadPartyMap.leadId,
          name: businessParties.name,
          assignedAt: businessParties.assignedAt,
          assignedToId: businessParties.ownerUserId,
          status: leadStatus,
        })
        .from(leadPartyMap)
        .innerJoin(businessParties, PARTY_OF_LEAD)
        .where(and(eq(leadPartyMap.organizationId, orgId), eq(businessParties.ownerUserId, userId), gte(businessParties.assignedAt, fortyEightHoursAgo), not(inArray(leadStatus, terminalLeadKeys)), isNull(businessParties.deletedAt)))
        .orderBy(desc(businessParties.assignedAt))
        .limit(10),

      this.aiActions.computeAiActions(orgId, userId, scope, terminalLeadKeys, openStageKeys),
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
      aiActions: aiActionsResult,
    };
  }

  async getCounts(orgId: string, userId: string, scope: DataScope): Promise<InboxCounts> {
    const now = new Date();
    const todayStart = startOfDay(now);
    const todayEnd = endOfDay(now);
    const fortyEightHoursAgo = new Date(now.getTime() - INBOX_REPLY_LOOKBACK_MS);
    const fourteenDaysAgo = new Date(now.getTime() - INBOX_ACTIVITY_LOOKBACK_MS);
    const fourHoursFromNow = new Date(now.getTime() + INBOX_SLA_HORIZON_MS);

    const scopeFilter = applyScope(scope, orgId, userId, { ownerColumn: tasks.assigneeId });
    const leadScopeFilter = applyScope(scope, orgId, userId, { ownerColumn: businessParties.ownerUserId });

    const { terminalLeadKeys, openStageKeys } = await this.aiActions.resolveMetadata(orgId);

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
      this.db.select({ n: sql<number>`count(*)` }).from(tasks).where(and(eq(tasks.orgId, orgId), eq(tasks.status, "pending"), gte(tasks.dueDate, todayStart), lte(tasks.dueDate, todayEnd), isNull(tasks.snoozedUntil), scopeFilter)).then((r) => Number(r[0]?.n ?? 0)),
      this.db.select({ n: sql<number>`count(*)` }).from(tasks).where(and(eq(tasks.orgId, orgId), eq(tasks.status, "pending"), lt(tasks.dueDate, todayStart), isNull(tasks.snoozedUntil), scopeFilter)).then((r) => Number(r[0]?.n ?? 0)),
      this.db.select({ n: sql<number>`count(*)` }).from(leadPartyMap).innerJoin(businessParties, PARTY_OF_LEAD).where(and(eq(leadPartyMap.organizationId, orgId), not(inArray(leadStatus, terminalLeadKeys)), lte(businessParties.nextFollowUpAt, now), isNull(businessParties.deletedAt), leadScopeFilter)).then((r) => Number(r[0]?.n ?? 0)),
      this.db.select({ n: sql<number>`count(*)` }).from(leadEmails).where(and(eq(leadEmails.orgId, orgId), eq(leadEmails.direction, "received"), gte(leadEmails.sentAt, fortyEightHoursAgo))).then((r) => Number(r[0]?.n ?? 0)),
      this.db.select({ n: sql<number>`count(*)` }).from(dealMeetings).where(and(eq(dealMeetings.orgId, orgId), eq(dealMeetings.status, "scheduled"), gte(dealMeetings.scheduledAt, todayStart), lte(dealMeetings.scheduledAt, todayEnd))).then((r) => Number(r[0]?.n ?? 0)),
      this.db.select({ n: sql<number>`count(*)` }).from(leadPartyMap).innerJoin(businessParties, PARTY_OF_LEAD).where(and(eq(leadPartyMap.organizationId, orgId), not(inArray(leadStatus, terminalLeadKeys)), lte(businessParties.slaDueAt, fourHoursFromNow), isNull(businessParties.deletedAt), leadScopeFilter)).then((r) => Number(r[0]?.n ?? 0)),
      openStageKeys.length > 0
        ? this.db.select({ n: sql<number>`count(*)` }).from(deals).where(and(eq(deals.orgId, orgId), isNull(deals.deletedAt), inArray(deals.stage, openStageKeys), not(sql`EXISTS (SELECT 1 FROM deal_activities da WHERE da.deal_id = ${deals.id} AND da.created_at >= ${fourteenDaysAgo.toISOString()})`))).then((r) => Number(r[0]?.n ?? 0))
        : Promise.resolve(0),
      this.db.select({ n: sql<number>`count(*)` }).from(leadPartyMap).innerJoin(businessParties, PARTY_OF_LEAD).where(and(eq(leadPartyMap.organizationId, orgId), eq(businessParties.ownerUserId, userId), gte(businessParties.assignedAt, fortyEightHoursAgo), not(inArray(leadStatus, terminalLeadKeys)), isNull(businessParties.deletedAt))).then((r) => Number(r[0]?.n ?? 0)),
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
}
