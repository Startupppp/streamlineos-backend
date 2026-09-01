import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from "@nestjs/common";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { StorageService } from "../storage/storage.service";
import { forEachOrg } from "../../common/tenant";
import {
  GdprExportService,
  type GdprExportJobRow,
} from "./gdpr-export.service";
import { APP_CONFIG } from "../../config/config.module";
import type { AppConfig } from "../../config/env.validation";
import {
  countExportRows,
  drainExportPages,
  type ExportSection,
} from "./gdpr-export-types";
import {
  EMPLOYMENT_SCOPED_TABLES,
  MEMBERSHIP_SCOPED_TABLES,
  REQUIRED_GDPR_EXPORT_SOURCES,
  SUBJECT_SCOPED_TABLES,
} from "./gdpr-export-adapters";
import { fetchSubject, fetchMemberships, fetchAuditEntries } from "./gdpr-export-fetchers-auth";
import {
  fetchSubjectFileKeys,
  fetchSubjectScopedRows,
  fetchMembershipScopedRows,
  fetchEmploymentScopedRows,
} from "./gdpr-export-fetchers-generic";
import {
  fetchEmployment,
  fetchDataRequests,
  fetchLegalHolds,
  fetchReportingLines,
  fetchAttendanceRegularizations,
  fetchDocuments,
  fetchPolicyAcknowledgments,
  fetchOnboardingDocuments,
  fetchAssetReturns,
} from "./gdpr-export-fetchers-hr";
import {
  fetchAiFeedback,
  fetchAiActionProposals,
  fetchAiJobs,
  fetchAiUsageLogs,
  fetchAiChatConversations,
  fetchAiChatMessages,
} from "./gdpr-export-fetchers-ai";
import {
  fetchChatChannelMembers,
  fetchChatMessages,
  fetchChatReactions,
  fetchChatAttachments,
  fetchChatPins,
  fetchChatSaves,
  fetchChatReminders,
} from "./gdpr-export-fetchers-chat";
import {
  fetchMail,
  fetchNotifications,
  fetchNotificationReadWatermarks,
  fetchNotificationDeliveries,
  fetchNotificationPreferences,
} from "./gdpr-export-fetchers-notifications";
import {
  fetchExpenses,
  fetchReimbursements,
  fetchSalaryLoans,
  fetchBonuses,
  fetchFnfSettlements,
} from "./gdpr-export-fetchers-financial";

export { countExportRows, drainExportPages } from "./gdpr-export-types";
export {
  GDPR_EXPORT_SOURCE_ADAPTERS,
  GENERIC_GDPR_EXPORT_EXCLUDED_SOURCES,
  REQUIRED_GDPR_EXPORT_SOURCES,
  SUBJECT_SCOPED_GDPR_EXPORT_SOURCES,
} from "./gdpr-export-adapters";

@Injectable()
export class GdprExportWorkerImplementation
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(GdprExportWorkerImplementation.name);
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly jobs: GdprExportService,
    private readonly storage: StorageService,
    @Optional()
    @Inject(APP_CONFIG)
    private readonly config?: Pick<AppConfig, "GDPR_EXPORT_WORKER_ENABLED">,
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

  private fetchSection(
    fetcher: (afterId: number | undefined) => Promise<Array<{ id: number } & Record<string, unknown>>>,
  ): Promise<ExportSection> {
    return drainExportPages(fetcher);
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
      const subject = await fetchSubject(this.db, job.subjectUserId);
      const fileKeys = await fetchSubjectFileKeys(this.db, job.orgId, job.subjectUserId);
      const memberships = await this.fetchSection((afterId) =>
        fetchMemberships(this.db, job.orgId, job.subjectUserId, afterId),
      );
      const employment = await this.fetchSection((afterId) =>
        fetchEmployment(this.db, job.orgId, job.subjectUserId, afterId),
      );
      const reportingLines = await this.fetchSection((afterId) =>
        fetchReportingLines(this.db, job.orgId, job.subjectUserId, afterId),
      );
      const dataRequests = await this.fetchSection((afterId) =>
        fetchDataRequests(this.db, job.orgId, job.subjectUserId, afterId),
      );
      const attendanceRegularizations = await this.fetchSection((afterId) =>
        fetchAttendanceRegularizations(this.db, job.orgId, job.subjectUserId, afterId),
      );
      const legalHolds = await this.fetchSection((afterId) =>
        fetchLegalHolds(this.db, job.orgId, job.subjectUserId, afterId),
      );
      const auditEntries = await this.fetchSection((afterId) =>
        fetchAuditEntries(this.db, job.orgId, job.subjectUserId, afterId),
      );
      const aiChatConversationRows = await this.fetchSection((afterId) =>
        fetchAiChatConversations(this.db, job.orgId, job.subjectUserId, afterId),
      );
      const aiChatMessageRows = await this.fetchSection((afterId) =>
        fetchAiChatMessages(this.db, job.orgId, job.subjectUserId, afterId),
      );
      const aiFeedbackRows = await this.fetchSection((afterId) =>
        fetchAiFeedback(this.db, job.orgId, job.subjectUserId, afterId),
      );
      const aiActionProposalRows = await this.fetchSection((afterId) =>
        fetchAiActionProposals(this.db, job.orgId, job.subjectUserId, afterId),
      );
      const aiJobRows = await this.fetchSection((afterId) =>
        fetchAiJobs(this.db, job.orgId, job.subjectUserId, afterId),
      );
      const aiUsageLogRows = await this.fetchSection((afterId) =>
        fetchAiUsageLogs(this.db, job.orgId, job.subjectUserId, afterId),
      );
      const chatChannelMemberRows = await this.fetchSection((afterId) =>
        fetchChatChannelMembers(this.db, job.orgId, job.subjectUserId, afterId),
      );
      const chatMessageRows = await this.fetchSection((afterId) =>
        fetchChatMessages(this.db, job.orgId, job.subjectUserId, afterId),
      );
      const chatReactionRows = await this.fetchSection((afterId) =>
        fetchChatReactions(this.db, job.orgId, job.subjectUserId, afterId),
      );
      const chatAttachmentRows = await this.fetchSection((afterId) =>
        fetchChatAttachments(this.db, job.orgId, job.subjectUserId, afterId),
      );
      const chatPinRows = await this.fetchSection((afterId) =>
        fetchChatPins(this.db, job.orgId, job.subjectUserId, afterId),
      );
      const chatSaveRows = await this.fetchSection((afterId) =>
        fetchChatSaves(this.db, job.orgId, job.subjectUserId, afterId),
      );
      const chatReminderRows = await this.fetchSection((afterId) =>
        fetchChatReminders(this.db, job.orgId, job.subjectUserId, afterId),
      );
      const mailRows = await this.fetchSection((afterId) =>
        fetchMail(this.db, job.orgId, job.subjectUserId, afterId),
      );
      const notificationRows = await this.fetchSection((afterId) =>
        fetchNotifications(this.db, job.orgId, job.subjectUserId, afterId),
      );
      const notificationReadRows = await this.fetchSection((afterId) =>
        fetchNotificationReadWatermarks(this.db, job.orgId, job.subjectUserId, afterId),
      );
      const notificationDeliveryRows = await this.fetchSection((afterId) =>
        fetchNotificationDeliveries(this.db, job.orgId, job.subjectUserId, afterId),
      );
      const notificationPreferenceRows = await this.fetchSection((afterId) =>
        fetchNotificationPreferences(this.db, job.orgId, job.subjectUserId, afterId),
      );
      const documentRows = await this.fetchSection((afterId) =>
        fetchDocuments(this.db, job.orgId, job.subjectUserId, afterId),
      );
      const policyAcknowledgmentRows = await this.fetchSection((afterId) =>
        fetchPolicyAcknowledgments(this.db, job.orgId, job.subjectUserId, afterId),
      );
      const onboardingDocumentRows = await this.fetchSection((afterId) =>
        fetchOnboardingDocuments(this.db, job.orgId, job.subjectUserId, afterId),
      );
      const financial = await Promise.all([
        this.fetchSection((afterId) =>
          fetchExpenses(this.db, job.orgId, job.subjectUserId, afterId),
        ),
        this.fetchSection((afterId) =>
          fetchReimbursements(this.db, job.orgId, job.subjectUserId, afterId),
        ),
        this.fetchSection((afterId) =>
          fetchSalaryLoans(this.db, job.orgId, job.subjectUserId, afterId),
        ),
        this.fetchSection((afterId) =>
          fetchBonuses(this.db, job.orgId, job.subjectUserId, afterId),
        ),
        this.fetchSection((afterId) =>
          fetchFnfSettlements(this.db, job.orgId, job.subjectUserId, afterId),
        ),
        this.fetchSection((afterId) =>
          fetchAssetReturns(this.db, job.orgId, job.subjectUserId, afterId),
        ),
      ]);
      const subjectScopedSections = await Promise.all(
        SUBJECT_SCOPED_TABLES.map(async ({ source, table, userColumn }) => ({
          source,
          rows: (
            await drainExportPages((afterId) =>
              fetchSubjectScopedRows(
                this.db,
                table,
                userColumn,
                job.orgId,
                job.subjectUserId,
                afterId,
              ),
            )
          ).rows,
        })),
      );
      const membershipScopedSections = await Promise.all(
        MEMBERSHIP_SCOPED_TABLES.map(
          async ({ source, table, membershipColumn }) => ({
            source,
            rows: (
              await drainExportPages((afterId) =>
                fetchMembershipScopedRows(
                  this.db,
                  table,
                  membershipColumn,
                  job.orgId,
                  job.subjectUserId,
                  afterId,
                ),
              )
            ).rows,
          }),
        ),
      );
      const employmentScopedSections = await Promise.all(
        EMPLOYMENT_SCOPED_TABLES.map(
          async ({ source, table, employmentColumn }) => ({
            source,
            rows: (
              await drainExportPages((afterId) =>
                fetchEmploymentScopedRows(
                  this.db,
                  table,
                  employmentColumn,
                  job.orgId,
                  job.subjectUserId,
                  afterId,
                ),
              )
            ).rows,
          }),
        ),
      );

      const additionalSections = {
        chatChannelMembers: chatChannelMemberRows.rows,
        chatMessages: chatMessageRows.rows,
        chatReactions: chatReactionRows.rows,
        chatAttachments: chatAttachmentRows.rows,
        chatPins: chatPinRows.rows,
        chatSaves: chatSaveRows.rows,
        chatReminders: chatReminderRows.rows,
        mail: mailRows.rows,
        notifications: notificationRows.rows,
        notificationReadWatermarks: notificationReadRows.rows,
        notificationDeliveries: notificationDeliveryRows.rows,
        notificationPreferences: notificationPreferenceRows.rows,
        documents: documentRows.rows,
        policyAcknowledgments: policyAcknowledgmentRows.rows,
        onboardingDocuments: onboardingDocumentRows.rows,
        expenses: financial[0].rows,
        reimbursements: financial[1].rows,
        salaryLoans: financial[2].rows,
        bonuses: financial[3].rows,
        fnfSettlements: financial[4].rows,
        assetReturns: financial[5].rows,
        ...Object.fromEntries(
          subjectScopedSections.map(({ source, rows }) => [source, rows]),
        ),
        ...Object.fromEntries(
          membershipScopedSections.map(({ source, rows }) => [source, rows]),
        ),
        ...Object.fromEntries(
          employmentScopedSections.map(({ source, rows }) => [source, rows]),
        ),
      };

      const totalRows = countExportRows(
        memberships,
        employment,
        reportingLines,
        dataRequests,
        attendanceRegularizations,
        legalHolds,
        auditEntries,
        aiChatConversationRows,
        aiChatMessageRows,
        aiFeedbackRows,
        aiActionProposalRows,
        aiJobRows,
        aiUsageLogRows,
        ...Object.values(additionalSections).map((rows) => ({ rows })),
      );

      const payload = JSON.stringify({
        exportedAt: new Date().toISOString(),
        subject,
        sections: {
          memberships: memberships.rows,
          employment: employment.rows,
          reportingLines: reportingLines.rows,
          dataRequests: dataRequests.rows,
          attendanceRegularizations: attendanceRegularizations.rows,
          legalHolds: legalHolds.rows,
          auditEntries: auditEntries.rows,
          aiChatConversations: aiChatConversationRows.rows,
          aiChatMessages: aiChatMessageRows.rows,
          aiFeedback: aiFeedbackRows.rows,
          aiActionProposals: aiActionProposalRows.rows,
          aiJobs: aiJobRows.rows,
          aiUsageLogs: aiUsageLogRows.rows,
          ...additionalSections,
        },
        coverage: {
          sources: REQUIRED_GDPR_EXPORT_SOURCES,
          blobObjects: fileKeys,
          blobContents:
            "metadata only; object keys are enumerated for the subject and actual bytes remain in storage",
        },
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
}
