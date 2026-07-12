import { Inject, Injectable } from "@nestjs/common";
import { and, avg, count, eq, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";
import {
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

const OPEN_STATUSES = ["sent", "delivered", "partially_completed"] as const;
const RECIPIENT_ACTIONABLE_STATUSES = ["invited", "viewed", "authenticated", "signing"] as const;

@Injectable()
export class SignReportsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly settings: SignSettingsService,
  ) {}

  async getDashboard(orgId: string, userId: string) {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const orgSettings = await this.settings.getOrCreate(orgId);
    const expiringBefore = new Date(now.getTime() + orgSettings.expirationWarningDays * 24 * 60 * 60 * 1000);

    const [awaitingMe] = await this.db
      .select({ value: count() })
      .from(signRecipients)
      .where(and(eq(signRecipients.orgId, orgId), eq(signRecipients.userId, userId), inArray(signRecipients.status, [...RECIPIENT_ACTIONABLE_STATUSES])));

    const [sentPending] = await this.db
      .select({ value: count() })
      .from(signEnvelopes)
      .where(and(eq(signEnvelopes.orgId, orgId), eq(signEnvelopes.senderUserId, userId), inArray(signEnvelopes.status, [...OPEN_STATUSES])));

    const [completedThisMonth] = await this.db
      .select({ value: count() })
      .from(signEnvelopes)
      .where(and(eq(signEnvelopes.orgId, orgId), eq(signEnvelopes.senderUserId, userId), eq(signEnvelopes.status, "completed"), gte(signEnvelopes.completedAt, monthStart)));

    const [expiringSoon] = await this.db
      .select({ value: count() })
      .from(signEnvelopes)
      .where(
        and(
          eq(signEnvelopes.orgId, orgId),
          eq(signEnvelopes.senderUserId, userId),
          inArray(signEnvelopes.status, [...OPEN_STATUSES]),
          isNotNull(signEnvelopes.expiresAt),
          lte(signEnvelopes.expiresAt, expiringBefore),
        ),
      );

    const [failedEnvelopes] = await this.db
      .select({ value: count() })
      .from(signEnvelopes)
      .where(and(eq(signEnvelopes.orgId, orgId), eq(signEnvelopes.senderUserId, userId), eq(signEnvelopes.status, "failed")));

    const [bouncedRecipients] = await this.db
      .select({ value: count() })
      .from(signRecipients)
      .innerJoin(signEnvelopes, eq(signRecipients.envelopeId, signEnvelopes.id))
      .where(and(eq(signEnvelopes.orgId, orgId), eq(signEnvelopes.senderUserId, userId), eq(signRecipients.status, "bounced")));

    const recentActivity = await this.db.query.signAuditEvents.findMany({
      where: eq(signAuditEvents.orgId, orgId),
      orderBy: (e, { desc }) => [desc(e.createdAt)],
      limit: 10,
    });

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
    const orgSettings = await this.settings.getOrCreate(orgId);
    const expiringBefore = new Date(Date.now() + orgSettings.expirationWarningDays * 24 * 60 * 60 * 1000);

    const byStatusRows = await this.db
      .select({ status: signEnvelopes.status, value: count() })
      .from(signEnvelopes)
      .where(eq(signEnvelopes.orgId, orgId))
      .groupBy(signEnvelopes.status);
    const byStatus = Object.fromEntries(byStatusRows.map((r) => [r.status, r.value]));

    const [expiringSoonRow] = await this.db
      .select({ value: count() })
      .from(signEnvelopes)
      .where(
        and(
          eq(signEnvelopes.orgId, orgId),
          inArray(signEnvelopes.status, [...OPEN_STATUSES]),
          isNotNull(signEnvelopes.expiresAt),
          lte(signEnvelopes.expiresAt, expiringBefore),
        ),
      );

    const [avgTimeRow] = await this.db
      .select({ avgHours: avg(sql<number>`EXTRACT(EPOCH FROM (${signEnvelopes.completedAt} - ${signEnvelopes.sentAt})) / 3600`) })
      .from(signEnvelopes)
      .where(and(eq(signEnvelopes.orgId, orgId), eq(signEnvelopes.status, "completed"), isNotNull(signEnvelopes.sentAt)));

    const totalSent = byStatusRows.filter((r) => r.status !== "draft" && r.status !== "ready_to_send").reduce((sum, r) => sum + r.value, 0);
    const completedCount = byStatus.completed ?? 0;
    const declinedCount = byStatus.declined ?? 0;

    const senderRows = await this.db
      .select({
        senderUserId: signEnvelopes.senderUserId,
        senderName: users.name,
        sentCount: count(signEnvelopes.id),
      })
      .from(signEnvelopes)
      .innerJoin(users, eq(signEnvelopes.senderUserId, users.id))
      .where(eq(signEnvelopes.orgId, orgId))
      .groupBy(signEnvelopes.senderUserId, users.name)
      .orderBy(sql`COUNT(${signEnvelopes.id}) DESC`)
      .limit(10);

    const templateRows = await this.db
      .select({ templateId: signEnvelopes.templateId, templateName: signTemplates.name, value: count() })
      .from(signEnvelopes)
      .innerJoin(signTemplates, eq(signEnvelopes.templateId, signTemplates.id))
      .where(and(eq(signEnvelopes.orgId, orgId), isNotNull(signEnvelopes.templateId)))
      .groupBy(signEnvelopes.templateId, signTemplates.name)
      .orderBy(sql`COUNT(*) DESC`)
      .limit(10);

    const [bulkStatsRow] = await this.db
      .select({
        totalJobs: count(),
        totalRows: sql<number>`COALESCE(SUM(${signBulkSendJobs.totalCount}), 0)`,
        successRows: sql<number>`COALESCE(SUM(${signBulkSendJobs.successCount}), 0)`,
        failedRows: sql<number>`COALESCE(SUM(${signBulkSendJobs.failedCount}), 0)`,
      })
      .from(signBulkSendJobs)
      .where(eq(signBulkSendJobs.orgId, orgId));

    const [authFailuresRow] = await this.db
      .select({ value: count() })
      .from(signAuditEvents)
      .where(and(eq(signAuditEvents.orgId, orgId), eq(signAuditEvents.eventType, "authentication_failed")));

    const [watermarkUsageRow] = await this.db
      .select({ value: count() })
      .from(signCertificates)
      .where(and(eq(signCertificates.orgId, orgId), eq(signCertificates.watermarked, true)));

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
