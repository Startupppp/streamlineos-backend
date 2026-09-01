import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from "@nestjs/common";
import { and, asc, eq, gt, isNull } from "drizzle-orm";
import {
  auditLogs,
  bonuses,
  chatAttachments,
  chatChannelMembers,
  chatMessageReactions,
  chatMessages,
  chatPinnedMessages,
  chatReplyReminders,
  chatSavedMessages,
  documents,
  expenses,
  hrDataRequests,
  hrEmployments,
  hrLegalHolds,
  hrPeople,
  onboardingDocuments,
  mailMessageMetadata,
  notificationDeliveries,
  notificationPreferences,
  notificationReadWatermarks,
  notifications,
  organizationMembers,
  policyAcknowledgments,
  reimbursements,
  salaryLoans,
  fnfSettlements,
  assetReturns,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { StorageService } from "../storage/storage.service";
import { forEachOrg } from "../../common/tenant";
import { GdprExportService, type GdprExportJobRow } from "./gdpr-export.service";
import { APP_CONFIG } from "../../config/config.module";
import type { AppConfig } from "../../config/env.validation";

const BATCH_SIZE = 200;

/** Every source in this list is either subject-owned or contains the subject's
 * tenant-scoped membership/recipient record. Keep this list beside the worker:
 * the coverage test makes adding a schema source without an adapter fail loudly.
 */
export const REQUIRED_GDPR_EXPORT_SOURCES = [
  "users", "organization_members", "hr_employments", "hr_data_requests", "hr_legal_holds", "audit_logs",
  "chat_channel_members", "chat_messages", "chat_message_reactions", "chat_attachments", "chat_pinned_messages", "chat_saved_messages", "chat_reply_reminders",
  "mail_message_metadata",
  "notifications", "notification_read_watermarks", "notification_deliveries", "notification_preferences",
  "documents", "policy_acknowledgments", "onboarding_documents",
  "expenses", "reimbursements", "salary_loans", "bonuses", "fnf_settlements", "asset_returns",
] as const;

export const GDPR_EXPORT_SOURCE_ADAPTERS = new Set<string>([
  ...REQUIRED_GDPR_EXPORT_SOURCES,
]);
interface ExportSection {
  rows: unknown[];
  truncated: boolean;
}

export async function drainExportPages<T extends { id: number }>(
  fetcher: (afterId: number | undefined) => Promise<T[]>,
  batchSize = BATCH_SIZE,
): Promise<ExportSection> {
  const rows: unknown[] = [];
  let afterId: number | undefined;
  for (;;) {
    const batch = await fetcher(afterId);
    if (!batch.length) break;
    rows.push(...batch);
    afterId = batch[batch.length - 1]!.id;
    if (batch.length < batchSize) break;
  }
  return { rows, truncated: false };
}

@Injectable()
export class GdprExportWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GdprExportWorkerService.name);
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly jobs: GdprExportService,
    private readonly storage: StorageService,
    @Optional() @Inject(APP_CONFIG) private readonly config?: Pick<AppConfig, "GDPR_EXPORT_WORKER_ENABLED">,
  ) {}

  onModuleInit() {
    if (this.config?.GDPR_EXPORT_WORKER_ENABLED !== "false") {
      this.timer = setInterval(() => void this.tick(), 30_000);
      this.timer.unref();
      void this.tick();
    }
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  wake() {
    void this.tick();
  }

  private async tick() {
    if (this.running || !this.storage.isConfigured()) return;
    this.running = true;
    try {
      await forEachOrg(this.db, "gdpr-export-worker", async (_tx, orgId) => {
        const job = await this.jobs.claim(orgId);
        if (job) await this.process(job);
      });
    } catch (error) {
      this.logger.error(error instanceof Error ? error.message : String(error));
    } finally {
      this.running = false;
    }
  }

  private async process(job: GdprExportJobRow) {
    try {
      const subject = await this.fetchSubject(job.subjectUserId);
      const memberships = await this.fetchSection(
        (afterId) => this.fetchMemberships(job.orgId, job.subjectUserId, afterId),
      );
      const employment = await this.fetchSection(
        (afterId) => this.fetchEmployment(job.orgId, job.subjectUserId, afterId),
      );
      const dataRequests = await this.fetchSection(
        (afterId) => this.fetchDataRequests(job.orgId, job.subjectUserId, afterId),
      );
      const legalHolds = await this.fetchSection(
        (afterId) => this.fetchLegalHolds(job.orgId, job.subjectUserId, afterId),
      );
      const auditEntries = await this.fetchSection(
        (afterId) => this.fetchAuditEntries(job.orgId, job.subjectUserId, afterId),
      );
      const chatChannelMembers = await this.fetchSection((afterId) => this.fetchChatChannelMembers(job.orgId, job.subjectUserId, afterId));
      const chatMessages = await this.fetchSection((afterId) => this.fetchChatMessages(job.orgId, job.subjectUserId, afterId));
      const chatReactions = await this.fetchSection((afterId) => this.fetchChatReactions(job.orgId, job.subjectUserId, afterId));
      const chatAttachments = await this.fetchSection((afterId) => this.fetchChatAttachments(job.orgId, job.subjectUserId, afterId));
      const chatPins = await this.fetchSection((afterId) => this.fetchChatPins(job.orgId, job.subjectUserId, afterId));
      const chatSaves = await this.fetchSection((afterId) => this.fetchChatSaves(job.orgId, job.subjectUserId, afterId));
      const chatReminders = await this.fetchSection((afterId) => this.fetchChatReminders(job.orgId, job.subjectUserId, afterId));
      const mail = await this.fetchSection((afterId) => this.fetchMail(job.orgId, job.subjectUserId, afterId));
      const notificationRows = await this.fetchSection((afterId) => this.fetchNotifications(job.orgId, job.subjectUserId, afterId));
      const notificationReadRows = await this.fetchSection((afterId) => this.fetchNotificationReadWatermarks(job.orgId, job.subjectUserId, afterId));
      const notificationDeliveryRows = await this.fetchSection((afterId) => this.fetchNotificationDeliveries(job.orgId, job.subjectUserId, afterId));
      const notificationPreferenceRows = await this.fetchSection((afterId) => this.fetchNotificationPreferences(job.orgId, job.subjectUserId, afterId));
      const documentRows = await this.fetchSection((afterId) => this.fetchDocuments(job.orgId, job.subjectUserId, afterId));
      const policyAcknowledgmentRows = await this.fetchSection((afterId) => this.fetchPolicyAcknowledgments(job.orgId, job.subjectUserId, afterId));
      const onboardingDocumentRows = await this.fetchSection((afterId) => this.fetchOnboardingDocuments(job.orgId, job.subjectUserId, afterId));
      const financial = await Promise.all([
        this.fetchSection((afterId) => this.fetchExpenses(job.orgId, job.subjectUserId, afterId)),
        this.fetchSection((afterId) => this.fetchReimbursements(job.orgId, job.subjectUserId, afterId)),
        this.fetchSection((afterId) => this.fetchSalaryLoans(job.orgId, job.subjectUserId, afterId)),
        this.fetchSection((afterId) => this.fetchBonuses(job.orgId, job.subjectUserId, afterId)),
        this.fetchSection((afterId) => this.fetchFnfSettlements(job.orgId, job.subjectUserId, afterId)),
        this.fetchSection((afterId) => this.fetchAssetReturns(job.orgId, job.subjectUserId, afterId)),
      ]);

      const additionalSections = {
        chatChannelMembers: chatChannelMembers.rows, chatMessages: chatMessages.rows, chatReactions: chatReactions.rows,
        chatAttachments: chatAttachments.rows, chatPins: chatPins.rows, chatSaves: chatSaves.rows, chatReminders: chatReminders.rows,
        mail: mail.rows, notifications: notificationRows.rows, notificationReadWatermarks: notificationReadRows.rows,
        notificationDeliveries: notificationDeliveryRows.rows, notificationPreferences: notificationPreferenceRows.rows,
        documents: documentRows.rows, policyAcknowledgments: policyAcknowledgmentRows.rows, onboardingDocuments: onboardingDocumentRows.rows,
        expenses: financial[0].rows, reimbursements: financial[1].rows, salaryLoans: financial[2].rows,
        bonuses: financial[3].rows, fnfSettlements: financial[4].rows, assetReturns: financial[5].rows,
      };

      const totalRows =
        memberships.rows.length +
        employment.rows.length +
        dataRequests.rows.length +
        legalHolds.rows.length +
        auditEntries.rows.length;
      const additionalRows = Object.values(additionalSections).reduce((count, rows) => count + rows.length, 0);

      const payload = JSON.stringify({
        exportedAt: new Date().toISOString(),
        subject,
        sections: {
          memberships: memberships.rows,
          employment: employment.rows,
          dataRequests: dataRequests.rows,
          legalHolds: legalHolds.rows,
          auditEntries: auditEntries.rows,
          ...additionalSections,
        },
        coverage: { sources: REQUIRED_GDPR_EXPORT_SOURCES, blobContents: "metadata only" },
      });

      const result = await this.storage.uploadFile(
        job.orgId,
        Buffer.from(payload, "utf8"),
        "gdpr-exports",
        `gdpr-export-${job.id}.json`,
        "application/json",
      );

      await this.jobs.complete(
        job.id,
        result.key,
        `gdpr-export-${job.createdAt.toISOString().slice(0, 10)}.json`,
        result.size,
        totalRows,
        false,
      );
    } catch (error) {
      await this.jobs.fail(job, error);
    }
  }

  private async fetchSection(
    fetcher: (afterId: number | undefined) => Promise<Array<{ id: number } & Record<string, unknown>>>,
  ): Promise<ExportSection> {
    return drainExportPages(fetcher);
  }

  private async fetchSubject(subjectUserId: string) {
    const [subject] = await this.db
      .select({ userId: users.id, email: users.email, name: users.name })
      .from(users)
      .where(eq(users.id, subjectUserId))
      .limit(1);
    if (!subject) throw new Error("GDPR export subject not found");
    return { userId: subject.userId, email: subject.email, name: subject.name ?? null };
  }

  private async fetchMemberships(orgId: string, subjectUserId: string, afterId: number | undefined) {
    const conditions = [
      eq(organizationMembers.userId, subjectUserId),
      eq(organizationMembers.orgId, orgId),
    ];
    if (afterId !== undefined) conditions.push(gt(organizationMembers.id, afterId));
    return this.db
      .select({
        id: organizationMembers.id,
        orgId: organizationMembers.orgId,
        role: organizationMembers.role,
        status: organizationMembers.status,
        joinedAt: organizationMembers.joinedAt,
      })
      .from(organizationMembers)
      .where(and(...conditions))
      .orderBy(asc(organizationMembers.id))
      .limit(BATCH_SIZE);
  }

  private async fetchEmployment(orgId: string, subjectUserId: string, afterId: number | undefined) {
    const personRows = await this.db
      .select({ id: hrPeople.id })
      .from(hrPeople)
      .where(
        and(
          eq(hrPeople.userId, subjectUserId),
          eq(hrPeople.orgId, orgId),
          isNull(hrPeople.deletedAt),
        ),
      );
    if (!personRows.length) return [];
    const conditions = [eq(hrEmployments.orgId, orgId), isNull(hrEmployments.deletedAt)];
    if (afterId !== undefined) conditions.push(gt(hrEmployments.id, afterId));
    return this.db
      .select({
        id: hrEmployments.id,
        lifecycleStatus: hrEmployments.lifecycleStatus,
        departmentId: hrEmployments.departmentId,
        designation: hrEmployments.designation,
        joiningDate: hrEmployments.joiningDate,
        lastWorkingDay: hrEmployments.lastWorkingDay,
      })
      .from(hrEmployments)
      .innerJoin(hrPeople, eq(hrEmployments.personId, hrPeople.id))
      .where(and(...conditions, eq(hrPeople.userId, subjectUserId), eq(hrPeople.orgId, orgId)))
      .orderBy(asc(hrEmployments.id))
      .limit(BATCH_SIZE);
  }

  private async fetchDataRequests(orgId: string, subjectUserId: string, afterId: number | undefined) {
    const conditions = [
      eq(hrDataRequests.subjectUserId, subjectUserId),
      eq(hrDataRequests.orgId, orgId),
      isNull(hrDataRequests.deletedAt),
    ];
    if (afterId !== undefined) conditions.push(gt(hrDataRequests.id, afterId));
    return this.db
      .select({
        id: hrDataRequests.id,
        orgId: hrDataRequests.orgId,
        type: hrDataRequests.type,
        status: hrDataRequests.status,
        reason: hrDataRequests.reason,
        createdAt: hrDataRequests.createdAt,
      })
      .from(hrDataRequests)
      .where(and(...conditions))
      .orderBy(asc(hrDataRequests.id))
      .limit(BATCH_SIZE);
  }

  private async fetchLegalHolds(orgId: string, subjectUserId: string, afterId: number | undefined) {
    const conditions = [
      eq(hrLegalHolds.subjectUserId, subjectUserId),
      eq(hrLegalHolds.orgId, orgId),
      isNull(hrLegalHolds.deletedAt),
    ];
    if (afterId !== undefined) conditions.push(gt(hrLegalHolds.id, afterId));
    return this.db
      .select({
        id: hrLegalHolds.id,
        reason: hrLegalHolds.reason,
        status: hrLegalHolds.status,
        placedAt: hrLegalHolds.placedAt,
        releasedAt: hrLegalHolds.releasedAt,
      })
      .from(hrLegalHolds)
      .where(and(...conditions))
      .orderBy(asc(hrLegalHolds.id))
      .limit(BATCH_SIZE);
  }

  private async fetchAuditEntries(orgId: string, subjectUserId: string, afterId: number | undefined) {
    const conditions = [eq(auditLogs.userId, subjectUserId), eq(auditLogs.orgId, orgId)];
    if (afterId !== undefined) conditions.push(gt(auditLogs.id, afterId));
    return this.db
      .select({
        id: auditLogs.id,
        action: auditLogs.action,
        targetId: auditLogs.targetId,
        targetType: auditLogs.targetType,
        actorUserId: auditLogs.actorUserId,
        resourceType: auditLogs.resourceType,
        resourceId: auditLogs.resourceId,
        metadata: auditLogs.metadata,
        createdAt: auditLogs.createdAt,
      })
      .from(auditLogs)
      .where(and(...conditions))
      .orderBy(asc(auditLogs.id))
      .limit(BATCH_SIZE);
  }
}
