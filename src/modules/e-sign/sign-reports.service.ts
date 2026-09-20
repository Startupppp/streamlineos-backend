import { Inject, Injectable } from "@nestjs/common";
import { and, avg, count, desc, eq, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";
import {
  organizationMembers,
  signAuditEvents,
  signBulkSendJobs,
  signCertificates,
  signEnvelopes,
  signRecipients,
  signTemplates,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { SignSettingsService } from "./sign-settings.service";
import type { ScopedRead } from "../access/scoped-read";

const OPEN_STATUSES = ["sent", "delivered", "partially_completed"] as const;
const RECIPIENT_ACTIONABLE_STATUSES = ["invited", "viewed", "authenticated", "signing"] as const;

@Injectable()
export class SignReportsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly settings: SignSettingsService,
  ) {}

  async getDashboard(
    read: ScopedRead,
    membershipId: number | null,
  ) {
    const orgId = read.orgId;
    if (membershipId == null) {
      return { awaitingMe: 0, sentPending: 0, completedThisMonth: 0, expiringSoon: 0, failedOrBounced: 0, recentActivity: [] };
    }
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const orgSettings = await this.settings.get(orgId);
    const expiringBefore = new Date(now.getTime() + orgSettings.expirationWarningDays * 24 * 60 * 60 * 1000);

    const [
      [awaitingMe],
      [sentPending],
      [completedThisMonth],
      [expiringSoon],
      [failedEnvelopes],
      [bouncedRecipients],
      recentActivity,
    ] = await Promise.all([
      this.db
        .select({ value: count() })
        .from(signRecipients)
        .where(and(eq(signRecipients.orgId, orgId), eq(signRecipients.userMembershipId, membershipId), inArray(signRecipients.status, [...RECIPIENT_ACTIONABLE_STATUSES]))),
      this.db
        .select({ value: count() })
        .from(signEnvelopes)
        .where(and(eq(signEnvelopes.orgId, orgId), eq(signEnvelopes.senderMembershipId, membershipId), inArray(signEnvelopes.status, [...OPEN_STATUSES]))),
      this.db
        .select({ value: count() })
        .from(signEnvelopes)
        .where(and(eq(signEnvelopes.orgId, orgId), eq(signEnvelopes.senderMembershipId, membershipId), eq(signEnvelopes.status, "completed"), gte(signEnvelopes.completedAt, monthStart))),
      this.db
        .select({ value: count() })
        .from(signEnvelopes)
        .where(
          and(
            eq(signEnvelopes.orgId, orgId),
            eq(signEnvelopes.senderMembershipId, membershipId),
            inArray(signEnvelopes.status, [...OPEN_STATUSES]),
            isNotNull(signEnvelopes.expiresAt),
            lte(signEnvelopes.expiresAt, expiringBefore),
          ),
        ),
      this.db
        .select({ value: count() })
        .from(signEnvelopes)
        .where(and(eq(signEnvelopes.orgId, orgId), eq(signEnvelopes.senderMembershipId, membershipId), eq(signEnvelopes.status, "failed"))),
      this.db
        .select({ value: count() })
        .from(signRecipients)
        .innerJoin(signEnvelopes, eq(signRecipients.envelopeId, signEnvelopes.id))
        .where(and(eq(signEnvelopes.orgId, orgId), eq(signEnvelopes.senderMembershipId, membershipId), eq(signRecipients.status, "bounced"))),
      // Every other tile on this dashboard binds `senderMembershipId`; the
      // activity feed used to bind only the org, so an `own`-scoped sender read
      // the last ten audit events of every envelope in the organisation.
      this.db
        .select({
          id: signAuditEvents.id,
          envelopeId: signAuditEvents.envelopeId,
          recipientId: signAuditEvents.recipientId,
          actorType: signAuditEvents.actorType,
          actorName: signAuditEvents.actorName,
          actorEmail: signAuditEvents.actorEmail,
          eventType: signAuditEvents.eventType,
          eventMessage: signAuditEvents.eventMessage,
          createdAt: signAuditEvents.createdAt,
        })
        .from(signAuditEvents)
        .innerJoin(
          signEnvelopes,
          and(
            eq(signEnvelopes.orgId, signAuditEvents.orgId),
            eq(signEnvelopes.id, signAuditEvents.envelopeId),
          ),
        )
        .where(
          read.compose(
            { tenant: signAuditEvents.orgId, scope: { own: eq(signEnvelopes.senderMembershipId, membershipId) } },
            ({ sql: where }) => where,
            () => sql`false`,
          ),
        )
        .orderBy(desc(signAuditEvents.createdAt))
        .limit(10),
    ]);

    return {
      awaitingMe: awaitingMe.value,
      sentPending: sentPending.value,
      completedThisMonth: completedThisMonth.value,
      expiringSoon: expiringSoon.value,
      failedOrBounced: failedEnvelopes.value + bouncedRecipients.value,
      recentActivity,
    };
  }

  async getSummary(orgId: string) {
    const orgSettings = await this.settings.get(orgId);
    const expiringBefore = new Date(Date.now() + orgSettings.expirationWarningDays * 24 * 60 * 60 * 1000);

    const [
      byStatusRows,
      [expiringSoonRow],
      [avgTimeRow],
      senderRows,
      templateRows,
      [bulkStatsRow],
      [authFailuresRow],
      [watermarkUsageRow],
    ] = await Promise.all([
      this.db
        .select({ status: signEnvelopes.status, value: count() })
        .from(signEnvelopes)
        .where(eq(signEnvelopes.orgId, orgId))
        .groupBy(signEnvelopes.status),
      this.db
        .select({ value: count() })
        .from(signEnvelopes)
        .where(
          and(
            eq(signEnvelopes.orgId, orgId),
            inArray(signEnvelopes.status, [...OPEN_STATUSES]),
            isNotNull(signEnvelopes.expiresAt),
            lte(signEnvelopes.expiresAt, expiringBefore),
          ),
        ),
      this.db
        .select({ avgHours: avg(sql<number>`EXTRACT(EPOCH FROM (${signEnvelopes.completedAt} - ${signEnvelopes.sentAt})) / 3600`) })
        .from(signEnvelopes)
        .where(and(eq(signEnvelopes.orgId, orgId), eq(signEnvelopes.status, "completed"), isNotNull(signEnvelopes.sentAt))),
      this.db
        .select({
          senderMembershipId: signEnvelopes.senderMembershipId,
          senderName: users.name,
          sentCount: count(signEnvelopes.id),
        })
        .from(signEnvelopes)
        .innerJoin(
          organizationMembers,
          and(eq(organizationMembers.orgId, signEnvelopes.orgId), eq(organizationMembers.id, signEnvelopes.senderMembershipId)),
        )
        .innerJoin(users, eq(users.id, organizationMembers.userId))
        .where(eq(signEnvelopes.orgId, orgId))
        .groupBy(signEnvelopes.senderMembershipId, users.name)
        .orderBy(sql`COUNT(${signEnvelopes.id}) DESC`)
        .limit(10),
      this.db
        .select({ templateId: signEnvelopes.templateId, templateName: signTemplates.name, value: count() })
        .from(signEnvelopes)
        .innerJoin(signTemplates, eq(signEnvelopes.templateId, signTemplates.id))
        .where(and(eq(signEnvelopes.orgId, orgId), isNotNull(signEnvelopes.templateId)))
        .groupBy(signEnvelopes.templateId, signTemplates.name)
        .orderBy(sql`COUNT(*) DESC`)
        .limit(10),
      this.db
        .select({
          totalJobs: count(),
          totalRows: sql<number>`COALESCE(SUM(${signBulkSendJobs.totalCount}), 0)`,
          successRows: sql<number>`COALESCE(SUM(${signBulkSendJobs.successCount}), 0)`,
          failedRows: sql<number>`COALESCE(SUM(${signBulkSendJobs.failedCount}), 0)`,
        })
        .from(signBulkSendJobs)
        .where(eq(signBulkSendJobs.orgId, orgId)),
      this.db
        .select({ value: count() })
        .from(signAuditEvents)
        .where(and(eq(signAuditEvents.orgId, orgId), eq(signAuditEvents.eventType, "authentication_failed"))),
      this.db
        .select({ value: count() })
        .from(signCertificates)
        .where(and(eq(signCertificates.orgId, orgId), eq(signCertificates.watermarked, true))),
    ]);

    const byStatus = Object.fromEntries(byStatusRows.map((r) => [r.status, r.value]));
    const totalSent = byStatusRows.filter((r) => r.status !== "draft" && r.status !== "ready_to_send").reduce((sum, r) => sum + r.value, 0);
    const completedCount = byStatus.completed ?? 0;
    const declinedCount = byStatus.declined ?? 0;

    return {
      byStatus,
      avgTimeToSignHours: avgTimeRow?.avgHours ? Number(avgTimeRow.avgHours) : null,
      completionRate: totalSent > 0 ? completedCount / totalSent : 0,
      declineRate: totalSent > 0 ? declinedCount / totalSent : 0,
      expiringSoonCount: expiringSoonRow.value,
      senderPerformance: senderRows,
      templateUsage: templateRows,
      bulkSendStats: bulkStatsRow,
      authFailures: authFailuresRow.value,
      watermarkUsageCount: watermarkUsageRow.value,
    };
  }
}
