import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from "@nestjs/common";
import { and, asc, eq, getTableColumns, gt, isNull } from "drizzle-orm";
import type { AnyColumn } from "drizzle-orm";
import type { Table } from "drizzle-orm/table";
import {
  auditLogs,
  aiFeedback,
  aiActionProposals,
  aiJobs,
  aiUsageLogs,
  aiChatConversations,
  aiChatMessages,
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
  hrAttendanceRegularizations,
  hrAccommodationRequests,
  hrAccessProvisioning,
  hrBadgeAwards,
  hrCommunityMembers,
  hrEmergencyResponses,
  hrEmployments,
  hrLegalHolds,
  hrPeople,
  hrReportingLines,
  onboardingDocuments,
  onboardingTasks,
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
  attendance,
  compOffBalances,
  employeeDevices,
  employeeSalaryProfiles,
  employeeShiftAssignments,
  enpsScores,
  feedbackRequests,
  hrArrearsAdjustments,
  hrBenefitEnrollments,
  hrCompRecommendations,
  hrDependents,
  hrDeviceEmployeeMappings,
  hrEquityGrants,
  hrInsuranceClaims,
  hrLeaveLedger,
  hrMoodCheckins,
  hrPayrollAdjustments,
  hrPayrollInputSnapshots,
  hrPollVotes,
  hrRewardPointsLedger,
  hrTravelVisitLogs,
  hrWellnessCheckins,
  helpdeskTickets,
  leaveBalances,
  leaveRequests,
  notificationConsentEvents,
  overtimeRequests,
  payrollBankBatchItems,
  payrollExceptions,
  payrollInputs,
  payrollRunEmployees,
  payslipPublications,
  performanceImprovementPlans,
  performanceReviews,
  goals,
  employeeSkills,
  assessmentAttempts,
  rosterEntries,
  surveyResponses,
  taxDeclarations,
  travelRequests,
  users,
  wfhRequests,
  alumniProfiles,
  backgroundVerifications,
  certifications,
  resignations,
  terminations,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { StorageService } from "../storage/storage.service";
import {
  collectSubjectFileKeysWithLegalHold,
  enumerateFileKeyColumns,
} from "../storage/storage-key-catalog";
import { forEachOrg } from "../../common/tenant";
import {
  GdprExportService,
  type GdprExportJobRow,
} from "./gdpr-export.service";
import { APP_CONFIG } from "../../config/config.module";
import type { AppConfig } from "../../config/env.validation";

const BATCH_SIZE = 200;
type ExportCursor = string | number;

type SubjectScopedTable = Table & {
  id: AnyColumn;
  orgId: AnyColumn;
};

interface SubjectScopedAdapter {
  source: string;
  table: SubjectScopedTable;
  userColumn: AnyColumn;
}

/**
 * First-party tenant tables whose `user_id` is the data subject, rather than
 * merely an actor/creator projection. The generic adapter deliberately omits
 * credential material while retaining the table's other subject data.
 */
const SUBJECT_SCOPED_TABLE_DEFINITIONS: ReadonlyArray<
  readonly [string, SubjectScopedTable, AnyColumn]
> = [
  ["attendance", attendance, attendance.userId],
  ["comp_off_balances", compOffBalances, compOffBalances.userId],
  ["employee_devices", employeeDevices, employeeDevices.userId],
  [
    "employee_salary_profiles",
    employeeSalaryProfiles,
    employeeSalaryProfiles.userId,
  ],
  [
    "employee_shift_assignments",
    employeeShiftAssignments,
    employeeShiftAssignments.userId,
  ],
  ["enps_scores", enpsScores, enpsScores.userId],
  ["feedback_requests", feedbackRequests, feedbackRequests.subjectUserId],
  ["hr_arrears_adjustments", hrArrearsAdjustments, hrArrearsAdjustments.userId],
  [
    "hr_accommodation_requests",
    hrAccommodationRequests,
    hrAccommodationRequests.userId,
  ],
  ["hr_access_provisioning", hrAccessProvisioning, hrAccessProvisioning.userId],
  ["hr_badge_awards", hrBadgeAwards, hrBadgeAwards.userId],
  ["hr_benefit_enrollments", hrBenefitEnrollments, hrBenefitEnrollments.userId],
  ["hr_community_members", hrCommunityMembers, hrCommunityMembers.userId],
  [
    "hr_comp_recommendations",
    hrCompRecommendations,
    hrCompRecommendations.userId,
  ],
  ["hr_dependents", hrDependents, hrDependents.userId],
  [
    "hr_device_employee_mappings",
    hrDeviceEmployeeMappings,
    hrDeviceEmployeeMappings.userId,
  ],
  ["hr_emergency_responses", hrEmergencyResponses, hrEmergencyResponses.userId],
  ["hr_equity_grants", hrEquityGrants, hrEquityGrants.userId],
  ["hr_insurance_claims", hrInsuranceClaims, hrInsuranceClaims.userId],
  ["hr_leave_ledger", hrLeaveLedger, hrLeaveLedger.userId],
  ["hr_mood_checkins", hrMoodCheckins, hrMoodCheckins.userId],
  ["hr_payroll_adjustments", hrPayrollAdjustments, hrPayrollAdjustments.userId],
  [
    "hr_payroll_input_snapshots",
    hrPayrollInputSnapshots,
    hrPayrollInputSnapshots.userId,
  ],
  ["hr_poll_votes", hrPollVotes, hrPollVotes.userId],
  [
    "hr_reward_points_ledger",
    hrRewardPointsLedger,
    hrRewardPointsLedger.userId,
  ],
  ["hr_travel_visit_logs", hrTravelVisitLogs, hrTravelVisitLogs.userId],
  ["hr_wellness_checkins", hrWellnessCheckins, hrWellnessCheckins.userId],
  ["helpdesk_tickets", helpdeskTickets, helpdeskTickets.userId],
  ["leave_balances", leaveBalances, leaveBalances.userId],
  ["leave_requests", leaveRequests, leaveRequests.userId],
  [
    "notification_consent_events",
    notificationConsentEvents,
    notificationConsentEvents.userId,
  ],
  ["overtime_requests", overtimeRequests, overtimeRequests.userId],
  [
    "payroll_bank_batch_items",
    payrollBankBatchItems,
    payrollBankBatchItems.userId,
  ],
  ["payroll_exceptions", payrollExceptions, payrollExceptions.userId],
  ["payroll_inputs", payrollInputs, payrollInputs.userId],
  ["payroll_run_employees", payrollRunEmployees, payrollRunEmployees.userId],
  ["payslip_publications", payslipPublications, payslipPublications.userId],
  [
    "performance_improvement_plans",
    performanceImprovementPlans,
    performanceImprovementPlans.userId,
  ],
  ["performance_reviews", performanceReviews, performanceReviews.userId],
  ["goals", goals, goals.userId],
  ["employee_skills", employeeSkills, employeeSkills.userId],
  ["assessment_attempts", assessmentAttempts, assessmentAttempts.userId],
  ["roster_entries", rosterEntries, rosterEntries.userId],
  ["survey_responses", surveyResponses, surveyResponses.userId],
  ["tax_declarations", taxDeclarations, taxDeclarations.userId],
  ["travel_requests", travelRequests, travelRequests.userId],
  ["wfh_requests", wfhRequests, wfhRequests.userId],
  ["onboarding_tasks", onboardingTasks, onboardingTasks.userId],
  ["resignations", resignations, resignations.userId],
  ["terminations", terminations, terminations.userId],
  ["alumni_profiles", alumniProfiles, alumniProfiles.userId],
  [
    "background_verifications",
    backgroundVerifications,
    backgroundVerifications.userId,
  ],
  ["certifications", certifications, certifications.userId],
];

const SUBJECT_SCOPED_TABLES: readonly SubjectScopedAdapter[] =
  SUBJECT_SCOPED_TABLE_DEFINITIONS.map(([source, table, userColumn]) => ({
    source,
    table,
    userColumn,
  }));

const REDACTED_EXPORT_COLUMNS = new Set([
  "token",
  "tokenPrefix",
  "tokenEncrypted",
  "tokenHash",
  "codeHash",
  "keyHash",
  "auth",
  "p256dh",
  "configEncrypted",
  "composioConnectedAccountId",
  "endpoint",
  "reviewerUserId",
  "reviewerMembershipId",
  "approverId",
  "approverMembershipId",
  "assigneeId",
  "assigneeMembershipId",
  "managerId",
  "managerMembershipId",
  "hrRepId",
  "hrRepMembershipId",
  "managerApproverId",
  "managerApproverMembershipId",
  "financeApproverId",
  "financeApproverMembershipId",
  "coveringEmployeeId",
  "coveringEmployeeMembershipId",
  "createdBy",
  "createdByMembershipId",
  "updatedByMembershipId",
  "submittedBy",
  "calibratedBy",
  "approvedBy",
  "decidedBy",
  "decidedByMembershipId",
  "verifiedBy",
  "overriddenBy",
  "uploadedBy",
]);

/** Tables whose userId is an actor/recipient projection or a credential-bearing
 * delivery capability. They require reviewed, purpose-built projections. */
export const GENERIC_GDPR_EXPORT_EXCLUDED_SOURCES = [
  "announcement_reads",
  "agent_tokens",
  "notification_digest_runs",
  "notification_suppression_rules",
  "onboarding_analytics_events",
  "onboarding_flow_sessions",
  "push_subscriptions",
  "user_integration_connections",
  "user_tour_progress",
] as const;

export const SUBJECT_SCOPED_GDPR_EXPORT_SOURCES = SUBJECT_SCOPED_TABLES.map(
  ({ source }) => source,
);

/** Every source in this list is either subject-owned or contains the subject's
 * tenant-scoped membership/recipient record. Keep this list beside the worker:
 * the coverage test makes adding a schema source without an adapter fail loudly.
 */
export const REQUIRED_GDPR_EXPORT_SOURCES = [
  "users",
  "organization_members",
  "hr_employments",
  "hr_reporting_lines",
  "hr_data_requests",
  "hr_legal_holds",
  "audit_logs",
  "hr_attendance_regularizations",
  "ai_chat_conversations",
  "ai_chat_messages",
  "ai_feedback",
  "ai_action_proposals",
  "ai_jobs",
  "ai_usage_logs",
  "chat_channel_members",
  "chat_messages",
  "chat_message_reactions",
  "chat_attachments",
  "chat_pinned_messages",
  "chat_saved_messages",
  "chat_reply_reminders",
  "mail_message_metadata",
  "notifications",
  "notification_read_watermarks",
  "notification_deliveries",
  "notification_preferences",
  "documents",
  "policy_acknowledgments",
  "onboarding_documents",
  "expenses",
  "reimbursements",
  "salary_loans",
  "bonuses",
  "fnf_settlements",
  "asset_returns",
  ...SUBJECT_SCOPED_GDPR_EXPORT_SOURCES,
] as const;

export const GDPR_EXPORT_SOURCE_ADAPTERS = new Set<string>([
  ...REQUIRED_GDPR_EXPORT_SOURCES,
]);
interface ExportSection {
  rows: unknown[];
  truncated: boolean;
}

export function countExportRows(
  ...sections: Array<Pick<ExportSection, "rows">>
): number {
  return sections.reduce((count, section) => count + section.rows.length, 0);
}

export async function drainExportPages<C extends ExportCursor, T extends { id: C }>(
  fetcher: (afterId: C | undefined) => Promise<T[]>,
  batchSize = BATCH_SIZE,
): Promise<ExportSection> {
  const rows: unknown[] = [];
  let afterId: C | undefined;
  for (;;) {
    const batch = await fetcher(afterId);
    if (!batch.length) break;
    rows.push(...batch);
    const nextCursor = batch[batch.length - 1]!.id;
    if (afterId !== undefined && nextCursor === afterId)
      throw new Error("GDPR export cursor did not advance");
    afterId = nextCursor;
    if (batch.length < batchSize) break;
  }
  return { rows, truncated: false };
}

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
      const fileKeys = await this.fetchSubjectFileKeys(
        job.orgId,
        job.subjectUserId,
      );
      const memberships = await this.fetchSection((afterId) =>
        this.fetchMemberships(job.orgId, job.subjectUserId, afterId),
      );
      const employment = await this.fetchSection((afterId) =>
        this.fetchEmployment(job.orgId, job.subjectUserId, afterId),
      );
      const reportingLines = await this.fetchSection((afterId) =>
        this.fetchReportingLines(job.orgId, job.subjectUserId, afterId),
      );
      const dataRequests = await this.fetchSection((afterId) =>
        this.fetchDataRequests(job.orgId, job.subjectUserId, afterId),
      );
      const attendanceRegularizations = await this.fetchSection((afterId) =>
        this.fetchAttendanceRegularizations(
          job.orgId,
          job.subjectUserId,
          afterId,
        ),
      );
      const legalHolds = await this.fetchSection((afterId) =>
        this.fetchLegalHolds(job.orgId, job.subjectUserId, afterId),
      );
      const auditEntries = await this.fetchSection((afterId) =>
        this.fetchAuditEntries(job.orgId, job.subjectUserId, afterId),
      );
      const aiChatConversations = await this.fetchSection((afterId) =>
        this.fetchAiChatConversations(job.orgId, job.subjectUserId, afterId),
      );
      const aiChatMessages = await this.fetchSection((afterId) =>
        this.fetchAiChatMessages(job.orgId, job.subjectUserId, afterId),
      );
      const aiFeedback = await this.fetchSection((afterId) =>
        this.fetchAiFeedback(job.orgId, job.subjectUserId, afterId),
      );
      const aiActionProposals = await this.fetchSection((afterId) =>
        this.fetchAiActionProposals(job.orgId, job.subjectUserId, afterId),
      );
      const aiJobs = await this.fetchSection((afterId) =>
        this.fetchAiJobs(job.orgId, job.subjectUserId, afterId),
      );
      const aiUsageLogs = await this.fetchSection((afterId) =>
        this.fetchAiUsageLogs(job.orgId, job.subjectUserId, afterId),
      );
      const chatChannelMembers = await this.fetchSection((afterId) =>
        this.fetchChatChannelMembers(job.orgId, job.subjectUserId, afterId),
      );
      const chatMessages = await this.fetchSection((afterId) =>
        this.fetchChatMessages(job.orgId, job.subjectUserId, afterId),
      );
      const chatReactions = await this.fetchSection((afterId) =>
        this.fetchChatReactions(job.orgId, job.subjectUserId, afterId),
      );
      const chatAttachments = await this.fetchSection((afterId) =>
        this.fetchChatAttachments(job.orgId, job.subjectUserId, afterId),
      );
      const chatPins = await this.fetchSection((afterId) =>
        this.fetchChatPins(job.orgId, job.subjectUserId, afterId),
      );
      const chatSaves = await this.fetchSection((afterId) =>
        this.fetchChatSaves(job.orgId, job.subjectUserId, afterId),
      );
      const chatReminders = await this.fetchSection((afterId) =>
        this.fetchChatReminders(job.orgId, job.subjectUserId, afterId),
      );
      const mail = await this.fetchSection((afterId) =>
        this.fetchMail(job.orgId, job.subjectUserId, afterId),
      );
      const notificationRows = await this.fetchSection((afterId) =>
        this.fetchNotifications(job.orgId, job.subjectUserId, afterId),
      );
      const notificationReadRows = await this.fetchSection((afterId) =>
        this.fetchNotificationReadWatermarks(
          job.orgId,
          job.subjectUserId,
          afterId,
        ),
      );
      const notificationDeliveryRows = await this.fetchSection((afterId) =>
        this.fetchNotificationDeliveries(job.orgId, job.subjectUserId, afterId),
      );
      const notificationPreferenceRows = await this.fetchSection((afterId) =>
        this.fetchNotificationPreferences(
          job.orgId,
          job.subjectUserId,
          afterId,
        ),
      );
      const documentRows = await this.fetchSection((afterId) =>
        this.fetchDocuments(job.orgId, job.subjectUserId, afterId),
      );
      const policyAcknowledgmentRows = await this.fetchSection((afterId) =>
        this.fetchPolicyAcknowledgments(job.orgId, job.subjectUserId, afterId),
      );
      const onboardingDocumentRows = await this.fetchSection((afterId) =>
        this.fetchOnboardingDocuments(job.orgId, job.subjectUserId, afterId),
      );
      const financial = await Promise.all([
        this.fetchSection((afterId) =>
          this.fetchExpenses(job.orgId, job.subjectUserId, afterId),
        ),
        this.fetchSection((afterId) =>
          this.fetchReimbursements(job.orgId, job.subjectUserId, afterId),
        ),
        this.fetchSection((afterId) =>
          this.fetchSalaryLoans(job.orgId, job.subjectUserId, afterId),
        ),
        this.fetchSection((afterId) =>
          this.fetchBonuses(job.orgId, job.subjectUserId, afterId),
        ),
        this.fetchSection((afterId) =>
          this.fetchFnfSettlements(job.orgId, job.subjectUserId, afterId),
        ),
        this.fetchSection((afterId) =>
          this.fetchAssetReturns(job.orgId, job.subjectUserId, afterId),
        ),
      ]);
      const subjectScopedSections = await Promise.all(
        SUBJECT_SCOPED_TABLES.map(async ({ source, table, userColumn }) => ({
          source,
          rows: (
            await drainExportPages((afterId) =>
              this.fetchSubjectScopedRows(
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

      const additionalSections = {
        chatChannelMembers: chatChannelMembers.rows,
        chatMessages: chatMessages.rows,
        chatReactions: chatReactions.rows,
        chatAttachments: chatAttachments.rows,
        chatPins: chatPins.rows,
        chatSaves: chatSaves.rows,
        chatReminders: chatReminders.rows,
        mail: mail.rows,
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
      };

      const totalRows = countExportRows(
        memberships,
        employment,
        reportingLines,
        dataRequests,
        attendanceRegularizations,
        legalHolds,
        auditEntries,
        aiChatConversations,
        aiChatMessages,
        aiFeedback,
        aiActionProposals,
        aiJobs,
        aiUsageLogs,
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
          aiChatConversations: aiChatConversations.rows,
          aiChatMessages: aiChatMessages.rows,
          aiFeedback: aiFeedback.rows,
          aiActionProposals: aiActionProposals.rows,
          aiJobs: aiJobs.rows,
          aiUsageLogs: aiUsageLogs.rows,
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
    return {
      userId: subject.userId,
      email: subject.email,
      name: subject.name ?? null,
    };
  }

  private async fetchSubjectFileKeys(orgId: string, subjectUserId: string) {
    const columns = await enumerateFileKeyColumns(this.db);
    return collectSubjectFileKeysWithLegalHold(
      this.db,
      subjectUserId,
      [orgId],
      columns,
    );
  }

  private async fetchSubjectScopedRows(
    table: SubjectScopedTable,
    userColumn: AnyColumn,
    orgId: string,
    subjectUserId: string,
    afterId: ExportCursor | undefined,
  ): Promise<Array<{ id: ExportCursor } & Record<string, unknown>>> {
    const selectedColumns = Object.fromEntries(
      Object.entries(getTableColumns(table)).filter(
        ([name]) => !REDACTED_EXPORT_COLUMNS.has(name),
      ),
    );
    const conditions = [eq(table.orgId, orgId), eq(userColumn, subjectUserId)];
    if (afterId !== undefined) conditions.push(gt(table.id, afterId));
    const rows = await this.db
      .select(selectedColumns)
      .from(table)
      .where(and(...conditions))
      .orderBy(asc(table.id))
      .limit(BATCH_SIZE);
    return rows as Array<{ id: ExportCursor } & Record<string, unknown>>;
  }

  private async fetchMemberships(
    orgId: string,
    subjectUserId: string,
    afterId: number | undefined,
  ) {
    const conditions = [
      eq(organizationMembers.userId, subjectUserId),
      eq(organizationMembers.orgId, orgId),
    ];
    if (afterId !== undefined)
      conditions.push(gt(organizationMembers.id, afterId));
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

  private async fetchEmployment(
    orgId: string,
    subjectUserId: string,
    afterId: number | undefined,
  ) {
    const personRows = await this.db
      .select({ id: hrPeople.id })
      .from(hrPeople)
      .where(
        and(
          eq(hrPeople.userId, subjectUserId),
          eq(hrPeople.orgId, orgId),
          isNull(hrPeople.deletedAt),
        ),
      )
      .limit(1);
    if (!personRows.length) return [];
    const conditions = [
      eq(hrEmployments.orgId, orgId),
      isNull(hrEmployments.deletedAt),
    ];
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
      .where(
        and(
          ...conditions,
          eq(hrPeople.userId, subjectUserId),
          eq(hrPeople.orgId, orgId),
        ),
      )
      .orderBy(asc(hrEmployments.id))
      .limit(BATCH_SIZE);
  }

  private async fetchDataRequests(
    orgId: string,
    subjectUserId: string,
    afterId: number | undefined,
  ) {
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

  private async fetchLegalHolds(
    orgId: string,
    subjectUserId: string,
    afterId: number | undefined,
  ) {
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

  private async fetchReportingLines(
    orgId: string,
    subjectUserId: string,
    afterId: number | undefined,
  ) {
    const conditions = [
      eq(hrReportingLines.orgId, orgId),
      eq(hrPeople.userId, subjectUserId),
    ];
    if (afterId !== undefined)
      conditions.push(gt(hrReportingLines.id, afterId));
    return this.db
      .select({
        id: hrReportingLines.id,
        orgId: hrReportingLines.orgId,
        employmentId: hrReportingLines.employmentId,
        managerEmploymentId: hrReportingLines.managerEmploymentId,
        lineType: hrReportingLines.lineType,
        effectiveFrom: hrReportingLines.effectiveFrom,
        effectiveTo: hrReportingLines.effectiveTo,
        createdAt: hrReportingLines.createdAt,
      })
      .from(hrReportingLines)
      .innerJoin(
        hrEmployments,
        eq(hrReportingLines.employmentId, hrEmployments.id),
      )
      .innerJoin(hrPeople, eq(hrEmployments.personId, hrPeople.id))
      .where(and(...conditions))
      .orderBy(asc(hrReportingLines.id))
      .limit(BATCH_SIZE);
  }

  private async fetchAttendanceRegularizations(
    orgId: string,
    subjectUserId: string,
    afterId: number | undefined,
  ) {
    const conditions = [
      eq(hrAttendanceRegularizations.orgId, orgId),
      eq(hrAttendanceRegularizations.userId, subjectUserId),
    ];
    if (afterId !== undefined)
      conditions.push(gt(hrAttendanceRegularizations.id, afterId));
    return this.db
      .select({
        id: hrAttendanceRegularizations.id,
        orgId: hrAttendanceRegularizations.orgId,
        userId: hrAttendanceRegularizations.userId,
        attendanceDate: hrAttendanceRegularizations.attendanceDate,
        requestedCheckIn: hrAttendanceRegularizations.requestedCheckIn,
        requestedCheckOut: hrAttendanceRegularizations.requestedCheckOut,
        reason: hrAttendanceRegularizations.reason,
        status: hrAttendanceRegularizations.status,
        rejectionReason: hrAttendanceRegularizations.rejectionReason,
        attendanceId: hrAttendanceRegularizations.attendanceId,
        createdAt: hrAttendanceRegularizations.createdAt,
        updatedAt: hrAttendanceRegularizations.updatedAt,
      })
      .from(hrAttendanceRegularizations)
      .where(and(...conditions))
      .orderBy(asc(hrAttendanceRegularizations.id))
      .limit(BATCH_SIZE);
  }

  private async fetchAuditEntries(
    orgId: string,
    subjectUserId: string,
    afterId: number | undefined,
  ) {
    const conditions = [
      eq(auditLogs.userId, subjectUserId),
      eq(auditLogs.orgId, orgId),
    ];
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

  private async fetchAiFeedback(
    orgId: string,
    subjectUserId: string,
    afterId: number | undefined,
  ) {
    const conditions = [
      eq(aiFeedback.orgId, orgId),
      eq(aiFeedback.userId, subjectUserId),
    ];
    if (afterId !== undefined) conditions.push(gt(aiFeedback.id, afterId));
    return this.db
      .select({
        id: aiFeedback.id,
        feature: aiFeedback.feature,
        correlationId: aiFeedback.correlationId,
        entityType: aiFeedback.entityType,
        entityId: aiFeedback.entityId,
        rating: aiFeedback.rating,
        reason: aiFeedback.reason,
        metadata: aiFeedback.metadata,
        createdAt: aiFeedback.createdAt,
      })
      .from(aiFeedback)
      .where(and(...conditions))
      .orderBy(asc(aiFeedback.id))
      .limit(BATCH_SIZE);
  }

  private async fetchAiActionProposals(
    orgId: string,
    subjectUserId: string,
    afterId: number | undefined,
  ) {
    const conditions = [
      eq(aiActionProposals.orgId, orgId),
      eq(aiActionProposals.userId, subjectUserId),
    ];
    if (afterId !== undefined)
      conditions.push(gt(aiActionProposals.id, afterId));
    return this.db
      .select({
        id: aiActionProposals.id,
        action: aiActionProposals.action,
        payload: aiActionProposals.payload,
        payloadHash: aiActionProposals.payloadHash,
        status: aiActionProposals.status,
        idempotencyKey: aiActionProposals.idempotencyKey,
        expiresAt: aiActionProposals.expiresAt,
        executedAt: aiActionProposals.executedAt,
        result: aiActionProposals.result,
        createdAt: aiActionProposals.createdAt,
        updatedAt: aiActionProposals.updatedAt,
      })
      .from(aiActionProposals)
      .where(and(...conditions))
      .orderBy(asc(aiActionProposals.id))
      .limit(BATCH_SIZE);
  }

  private async fetchAiJobs(
    orgId: string,
    subjectUserId: string,
    afterId: number | undefined,
  ) {
    const conditions = [
      eq(aiJobs.orgId, orgId),
      eq(aiJobs.userId, subjectUserId),
    ];
    if (afterId !== undefined) conditions.push(gt(aiJobs.id, afterId));
    return this.db
      .select({
        id: aiJobs.id,
        type: aiJobs.type,
        payload: aiJobs.payload,
        status: aiJobs.status,
        priority: aiJobs.priority,
        attempts: aiJobs.attempts,
        maxAttempts: aiJobs.maxAttempts,
        idempotencyKey: aiJobs.idempotencyKey,
        runAt: aiJobs.runAt,
        lastError: aiJobs.lastError,
        result: aiJobs.result,
        createdAt: aiJobs.createdAt,
        updatedAt: aiJobs.updatedAt,
      })
      .from(aiJobs)
      .where(and(...conditions))
      .orderBy(asc(aiJobs.id))
      .limit(BATCH_SIZE);
  }

  private async fetchAiUsageLogs(
    orgId: string,
    subjectUserId: string,
    afterId: number | undefined,
  ) {
    const conditions = [
      eq(aiUsageLogs.orgId, orgId),
      eq(aiUsageLogs.userId, subjectUserId),
    ];
    if (afterId !== undefined) conditions.push(gt(aiUsageLogs.id, afterId));
    return this.db
      .select({
        id: aiUsageLogs.id,
        feature: aiUsageLogs.feature,
        model: aiUsageLogs.model,
        promptTokens: aiUsageLogs.promptTokens,
        completionTokens: aiUsageLogs.completionTokens,
        totalTokens: aiUsageLogs.totalTokens,
        estimatedCostUsd: aiUsageLogs.estimatedCostUsd,
        creditsMilli: aiUsageLogs.creditsMilli,
        metadata: aiUsageLogs.metadata,
        latencyMs: aiUsageLogs.latencyMs,
        correlationId: aiUsageLogs.correlationId,
        outcome: aiUsageLogs.outcome,
        createdAt: aiUsageLogs.createdAt,
      })
      .from(aiUsageLogs)
      .where(and(...conditions))
      .orderBy(asc(aiUsageLogs.id))
      .limit(BATCH_SIZE);
  }

  private async fetchAiChatConversations(
    orgId: string,
    subjectUserId: string,
    afterId: number | undefined,
  ) {
    const conditions = [
      eq(aiChatConversations.orgId, orgId),
      eq(aiChatConversations.userId, subjectUserId),
    ];
    if (afterId !== undefined)
      conditions.push(gt(aiChatConversations.id, afterId));
    return this.db
      .select({
        id: aiChatConversations.id,
        orgId: aiChatConversations.orgId,
        title: aiChatConversations.title,
        createdAt: aiChatConversations.createdAt,
        updatedAt: aiChatConversations.updatedAt,
      })
      .from(aiChatConversations)
      .where(and(...conditions))
      .orderBy(asc(aiChatConversations.id))
      .limit(BATCH_SIZE);
  }

  private async fetchAiChatMessages(
    orgId: string,
    subjectUserId: string,
    afterId: number | undefined,
  ) {
    const conditions = [
      eq(aiChatMessages.orgId, orgId),
      eq(aiChatMessages.userId, subjectUserId),
    ];
    if (afterId !== undefined) conditions.push(gt(aiChatMessages.id, afterId));
    return this.db
      .select({
        id: aiChatMessages.id,
        orgId: aiChatMessages.orgId,
        conversationId: aiChatMessages.conversationId,
        role: aiChatMessages.role,
        content: aiChatMessages.content,
        createdAt: aiChatMessages.createdAt,
      })
      .from(aiChatMessages)
      .where(and(...conditions))
      .orderBy(asc(aiChatMessages.id))
      .limit(BATCH_SIZE);
  }

  private async fetchChatChannelMembers(
    orgId: string,
    userId: string,
    afterId?: number,
  ) {
    const conditions = [
      eq(chatChannelMembers.orgId, orgId),
      eq(organizationMembers.userId, userId),
    ];
    if (afterId !== undefined)
      conditions.push(gt(chatChannelMembers.id, afterId));
    return this.db
      .select({
        id: chatChannelMembers.id,
        channelId: chatChannelMembers.channelId,
        role: chatChannelMembers.role,
        joinedAt: chatChannelMembers.joinedAt,
        archivedAt: chatChannelMembers.archivedAt,
      })
      .from(chatChannelMembers)
      .innerJoin(
        organizationMembers,
        eq(chatChannelMembers.membershipId, organizationMembers.id),
      )
      .where(and(...conditions))
      .orderBy(asc(chatChannelMembers.id))
      .limit(BATCH_SIZE);
  }

  private async fetchChatMessages(
    orgId: string,
    userId: string,
    afterId?: number,
  ) {
    const conditions = [
      eq(chatMessages.orgId, orgId),
      eq(organizationMembers.userId, userId),
    ];
    if (afterId !== undefined) conditions.push(gt(chatMessages.id, afterId));
    return this.db
      .select({
        id: chatMessages.id,
        channelId: chatMessages.channelId,
        content: chatMessages.content,
        replyToId: chatMessages.replyToId,
        isEdited: chatMessages.isEdited,
        isDeleted: chatMessages.isDeleted,
        messageType: chatMessages.messageType,
        actionStatus: chatMessages.actionStatus,
        createdAt: chatMessages.createdAt,
        updatedAt: chatMessages.updatedAt,
      })
      .from(chatMessages)
      .innerJoin(
        organizationMembers,
        eq(chatMessages.senderMembershipId, organizationMembers.id),
      )
      .where(and(...conditions))
      .orderBy(asc(chatMessages.id))
      .limit(BATCH_SIZE);
  }

  private async fetchChatReactions(
    orgId: string,
    userId: string,
    afterId?: number,
  ) {
    const conditions = [
      eq(chatMessageReactions.orgId, orgId),
      eq(organizationMembers.userId, userId),
    ];
    if (afterId !== undefined)
      conditions.push(gt(chatMessageReactions.id, afterId));
    return this.db
      .select({
        id: chatMessageReactions.id,
        messageId: chatMessageReactions.messageId,
        emoji: chatMessageReactions.emoji,
        createdAt: chatMessageReactions.createdAt,
      })
      .from(chatMessageReactions)
      .innerJoin(
        organizationMembers,
        eq(chatMessageReactions.membershipId, organizationMembers.id),
      )
      .where(and(...conditions))
      .orderBy(asc(chatMessageReactions.id))
      .limit(BATCH_SIZE);
  }

  private async fetchChatAttachments(
    orgId: string,
    userId: string,
    afterId?: number,
  ) {
    const conditions = [
      eq(chatAttachments.orgId, orgId),
      eq(organizationMembers.userId, userId),
    ];
    if (afterId !== undefined) conditions.push(gt(chatAttachments.id, afterId));
    return this.db
      .select({
        id: chatAttachments.id,
        messageId: chatAttachments.messageId,
        fileName: chatAttachments.fileName,
        fileSize: chatAttachments.fileSize,
        mimeType: chatAttachments.mimeType,
        createdAt: chatAttachments.createdAt,
      })
      .from(chatAttachments)
      .innerJoin(
        chatMessages,
        and(
          eq(chatAttachments.orgId, chatMessages.orgId),
          eq(chatAttachments.messageId, chatMessages.id),
        ),
      )
      .innerJoin(
        organizationMembers,
        eq(chatMessages.senderMembershipId, organizationMembers.id),
      )
      .where(and(...conditions))
      .orderBy(asc(chatAttachments.id))
      .limit(BATCH_SIZE);
  }

  private async fetchChatPins(orgId: string, userId: string, afterId?: number) {
    const conditions = [
      eq(chatPinnedMessages.orgId, orgId),
      eq(organizationMembers.userId, userId),
    ];
    if (afterId !== undefined)
      conditions.push(gt(chatPinnedMessages.id, afterId));
    return this.db
      .select({
        id: chatPinnedMessages.id,
        channelId: chatPinnedMessages.channelId,
        messageId: chatPinnedMessages.messageId,
        pinnedAt: chatPinnedMessages.pinnedAt,
      })
      .from(chatPinnedMessages)
      .innerJoin(
        organizationMembers,
        eq(chatPinnedMessages.pinnedByMembershipId, organizationMembers.id),
      )
      .where(and(...conditions))
      .orderBy(asc(chatPinnedMessages.id))
      .limit(BATCH_SIZE);
  }

  private async fetchChatSaves(
    orgId: string,
    userId: string,
    afterId?: number,
  ) {
    const conditions = [
      eq(chatSavedMessages.orgId, orgId),
      eq(organizationMembers.userId, userId),
    ];
    if (afterId !== undefined)
      conditions.push(gt(chatSavedMessages.id, afterId));
    return this.db
      .select({
        id: chatSavedMessages.id,
        messageId: chatSavedMessages.messageId,
        savedAt: chatSavedMessages.savedAt,
      })
      .from(chatSavedMessages)
      .innerJoin(
        organizationMembers,
        eq(chatSavedMessages.membershipId, organizationMembers.id),
      )
      .where(and(...conditions))
      .orderBy(asc(chatSavedMessages.id))
      .limit(BATCH_SIZE);
  }

  private async fetchChatReminders(
    orgId: string,
    userId: string,
    afterId?: number,
  ) {
    const conditions = [
      eq(chatReplyReminders.orgId, orgId),
      eq(organizationMembers.userId, userId),
    ];
    if (afterId !== undefined)
      conditions.push(gt(chatReplyReminders.id, afterId));
    return this.db
      .select({
        id: chatReplyReminders.id,
        channelId: chatReplyReminders.channelId,
        messageId: chatReplyReminders.messageId,
        remindAt: chatReplyReminders.remindAt,
        sentAt: chatReplyReminders.sentAt,
        cancelledAt: chatReplyReminders.cancelledAt,
        createdAt: chatReplyReminders.createdAt,
      })
      .from(chatReplyReminders)
      .innerJoin(
        organizationMembers,
        and(
          eq(chatReplyReminders.orgId, organizationMembers.orgId),
          eq(chatReplyReminders.recipientMembershipId, organizationMembers.id),
        ),
      )
      .where(and(...conditions))
      .orderBy(asc(chatReplyReminders.id))
      .limit(BATCH_SIZE);
  }

  private async fetchMail(orgId: string, userId: string, afterId?: number) {
    const conditions = [
      eq(mailMessageMetadata.orgId, orgId),
      eq(organizationMembers.userId, userId),
    ];
    if (afterId !== undefined)
      conditions.push(gt(mailMessageMetadata.id, afterId));
    return this.db
      .select({
        id: mailMessageMetadata.id,
        messageId: mailMessageMetadata.messageId,
        threadId: mailMessageMetadata.threadId,
        subject: mailMessageMetadata.subject,
        senderEmail: mailMessageMetadata.senderEmail,
        senderName: mailMessageMetadata.senderName,
        date: mailMessageMetadata.date,
        isRead: mailMessageMetadata.isRead,
        isStarred: mailMessageMetadata.isStarred,
        labels: mailMessageMetadata.labels,
        folder: mailMessageMetadata.folder,
        hasAttachment: mailMessageMetadata.hasAttachment,
        syncedAt: mailMessageMetadata.syncedAt,
      })
      .from(mailMessageMetadata)
      .innerJoin(
        organizationMembers,
        and(
          eq(mailMessageMetadata.orgId, organizationMembers.orgId),
          eq(mailMessageMetadata.userMembershipId, organizationMembers.id),
        ),
      )
      .where(and(...conditions))
      .orderBy(asc(mailMessageMetadata.id))
      .limit(BATCH_SIZE);
  }

  private async fetchNotifications(
    orgId: string,
    userId: string,
    afterId?: number,
  ) {
    const conditions = [
      eq(notifications.orgId, orgId),
      eq(organizationMembers.userId, userId),
    ];
    if (afterId !== undefined) conditions.push(gt(notifications.id, afterId));
    return this.db
      .select({
        id: notifications.id,
        createdAt: notifications.createdAt,
        type: notifications.type,
        priority: notifications.priority,
        category: notifications.category,
        sourceModule: notifications.sourceModule,
        entityType: notifications.entityType,
        entityId: notifications.entityId,
        reason: notifications.reason,
        title: notifications.title,
        message: notifications.message,
        link: notifications.link,
        isRead: notifications.isRead,
        pinned: notifications.pinned,
        channel: notifications.channel,
        archivedAt: notifications.archivedAt,
        deletedAt: notifications.deletedAt,
      })
      .from(notifications)
      .innerJoin(
        organizationMembers,
        and(
          eq(notifications.orgId, organizationMembers.orgId),
          eq(notifications.membershipId, organizationMembers.id),
        ),
      )
      .where(and(...conditions))
      .orderBy(asc(notifications.id))
      .limit(BATCH_SIZE);
  }

  private async fetchNotificationReadWatermarks(
    orgId: string,
    userId: string,
    afterId?: number,
  ) {
    const conditions = [
      eq(notificationReadWatermarks.orgId, orgId),
      eq(notificationReadWatermarks.userId, userId),
    ];
    if (afterId !== undefined)
      conditions.push(gt(notificationReadWatermarks.id, afterId));
    return this.db
      .select({
        id: notificationReadWatermarks.id,
        membershipId: notificationReadWatermarks.membershipId,
        lastReadNotificationId:
          notificationReadWatermarks.lastReadNotificationId,
        updatedAt: notificationReadWatermarks.updatedAt,
      })
      .from(notificationReadWatermarks)
      .where(and(...conditions))
      .orderBy(asc(notificationReadWatermarks.id))
      .limit(BATCH_SIZE);
  }

  private async fetchNotificationDeliveries(
    orgId: string,
    userId: string,
    afterId?: number,
  ) {
    const conditions = [
      eq(notificationDeliveries.orgId, orgId),
      eq(notificationDeliveries.userId, userId),
    ];
    if (afterId !== undefined)
      conditions.push(gt(notificationDeliveries.id, afterId));
    return this.db
      .select({
        id: notificationDeliveries.id,
        notificationId: notificationDeliveries.notificationId,
        eventKey: notificationDeliveries.eventKey,
        channel: notificationDeliveries.channel,
        status: notificationDeliveries.status,
        sentAt: notificationDeliveries.sentAt,
        deliveredAt: notificationDeliveries.deliveredAt,
        readAt: notificationDeliveries.readAt,
        clickedAt: notificationDeliveries.clickedAt,
        failedAt: notificationDeliveries.failedAt,
        failureCode: notificationDeliveries.failureCode,
        renderedSubject: notificationDeliveries.renderedSubject,
        renderedBody: notificationDeliveries.renderedBody,
        createdAt: notificationDeliveries.createdAt,
        updatedAt: notificationDeliveries.updatedAt,
      })
      .from(notificationDeliveries)
      .where(and(...conditions))
      .orderBy(asc(notificationDeliveries.id))
      .limit(BATCH_SIZE);
  }

  private async fetchNotificationPreferences(
    orgId: string,
    userId: string,
    afterId?: number,
  ) {
    const conditions = [
      eq(notificationPreferences.orgId, orgId),
      eq(notificationPreferences.userId, userId),
    ];
    if (afterId !== undefined)
      conditions.push(gt(notificationPreferences.id, afterId));
    return this.db
      .select({
        id: notificationPreferences.id,
        membershipId: notificationPreferences.membershipId,
        emailEnabled: notificationPreferences.emailEnabled,
        pushEnabled: notificationPreferences.pushEnabled,
        smsEnabled: notificationPreferences.smsEnabled,
        inAppEnabled: notificationPreferences.inAppEnabled,
        whatsappEnabled: notificationPreferences.whatsappEnabled,
        soundEnabled: notificationPreferences.soundEnabled,
        quietHoursStart: notificationPreferences.quietHoursStart,
        quietHoursEnd: notificationPreferences.quietHoursEnd,
        categories: notificationPreferences.categories,
        channelCategories: notificationPreferences.channelCategories,
        eventPreferences: notificationPreferences.eventPreferences,
        modulePreferences: notificationPreferences.modulePreferences,
        createdAt: notificationPreferences.createdAt,
        updatedAt: notificationPreferences.updatedAt,
      })
      .from(notificationPreferences)
      .where(and(...conditions))
      .orderBy(asc(notificationPreferences.id))
      .limit(BATCH_SIZE);
  }

  private async fetchDocuments(
    orgId: string,
    userId: string,
    afterId?: number,
  ) {
    const conditions = [
      eq(documents.orgId, orgId),
      eq(documents.userId, userId),
    ];
    if (afterId !== undefined) conditions.push(gt(documents.id, afterId));
    return this.db
      .select({
        id: documents.id,
        name: documents.name,
        description: documents.description,
        type: documents.type,
        category: documents.category,
        fileName: documents.fileName,
        fileSize: documents.fileSize,
        mimeType: documents.mimeType,
        version: documents.version,
        parentDocumentId: documents.parentDocumentId,
        isPublic: documents.isPublic,
        isActive: documents.isActive,
        expiryDate: documents.expiryDate,
        tags: documents.tags,
        uploadedBy: documents.uploadedBy,
        createdAt: documents.createdAt,
        updatedAt: documents.updatedAt,
      })
      .from(documents)
      .where(and(...conditions))
      .orderBy(asc(documents.id))
      .limit(BATCH_SIZE);
  }

  private async fetchPolicyAcknowledgments(
    orgId: string,
    userId: string,
    afterId?: number,
  ) {
    const conditions = [
      eq(policyAcknowledgments.orgId, orgId),
      eq(policyAcknowledgments.userId, userId),
    ];
    if (afterId !== undefined)
      conditions.push(gt(policyAcknowledgments.id, afterId));
    return this.db
      .select({
        id: policyAcknowledgments.id,
        documentId: policyAcknowledgments.documentId,
        status: policyAcknowledgments.status,
        acknowledgedAt: policyAcknowledgments.acknowledgedAt,
        createdAt: policyAcknowledgments.createdAt,
      })
      .from(policyAcknowledgments)
      .where(and(...conditions))
      .orderBy(asc(policyAcknowledgments.id))
      .limit(BATCH_SIZE);
  }

  private async fetchOnboardingDocuments(
    orgId: string,
    userId: string,
    afterId?: number,
  ) {
    const conditions = [
      eq(onboardingDocuments.orgId, orgId),
      eq(onboardingDocuments.userId, userId),
    ];
    if (afterId !== undefined)
      conditions.push(gt(onboardingDocuments.id, afterId));
    return this.db
      .select({
        id: onboardingDocuments.id,
        documentTypeId: onboardingDocuments.documentTypeId,
        fileName: onboardingDocuments.fileName,
        fileSize: onboardingDocuments.fileSize,
        mimeType: onboardingDocuments.mimeType,
        version: onboardingDocuments.version,
        status: onboardingDocuments.status,
        reviewedAt: onboardingDocuments.reviewedAt,
        remarks: onboardingDocuments.remarks,
        createdAt: onboardingDocuments.createdAt,
        updatedAt: onboardingDocuments.updatedAt,
      })
      .from(onboardingDocuments)
      .where(and(...conditions))
      .orderBy(asc(onboardingDocuments.id))
      .limit(BATCH_SIZE);
  }

  private async fetchExpenses(orgId: string, userId: string, afterId?: number) {
    const conditions = [eq(expenses.orgId, orgId), eq(expenses.userId, userId)];
    if (afterId !== undefined) conditions.push(gt(expenses.id, afterId));
    return this.db
      .select({
        id: expenses.id,
        category: expenses.category,
        amount: expenses.amount,
        currency: expenses.currency,
        description: expenses.description,
        receiptFileName: expenses.receiptFileName,
        merchant: expenses.merchant,
        receiptNumber: expenses.receiptNumber,
        taxAmount: expenses.taxAmount,
        paymentMethod: expenses.paymentMethod,
        status: expenses.status,
        approvedAt: expenses.approvedAt,
        rejectionReason: expenses.rejectionReason,
        paidAt: expenses.paidAt,
        transactionRef: expenses.transactionRef,
        policyFlag: expenses.policyFlag,
        expenseDate: expenses.expenseDate,
        createdAt: expenses.createdAt,
        updatedAt: expenses.updatedAt,
      })
      .from(expenses)
      .where(and(...conditions))
      .orderBy(asc(expenses.id))
      .limit(BATCH_SIZE);
  }

  private async fetchReimbursements(
    orgId: string,
    userId: string,
    afterId?: number,
  ) {
    const conditions = [
      eq(reimbursements.orgId, orgId),
      eq(reimbursements.userId, userId),
    ];
    if (afterId !== undefined) conditions.push(gt(reimbursements.id, afterId));
    return this.db
      .select({
        id: reimbursements.id,
        category: reimbursements.category,
        amount: reimbursements.amount,
        description: reimbursements.description,
        status: reimbursements.status,
        payrollMonth: reimbursements.payrollMonth,
        approvedAt: reimbursements.approvedAt,
        paidAt: reimbursements.paidAt,
        rejectionReason: reimbursements.rejectionReason,
        createdAt: reimbursements.createdAt,
        updatedAt: reimbursements.updatedAt,
      })
      .from(reimbursements)
      .where(and(...conditions))
      .orderBy(asc(reimbursements.id))
      .limit(BATCH_SIZE);
  }

  private async fetchSalaryLoans(
    orgId: string,
    userId: string,
    afterId?: number,
  ) {
    const conditions = [
      eq(salaryLoans.orgId, orgId),
      eq(salaryLoans.userId, userId),
    ];
    if (afterId !== undefined) conditions.push(gt(salaryLoans.id, afterId));
    return this.db
      .select({
        id: salaryLoans.id,
        amount: salaryLoans.amount,
        reason: salaryLoans.reason,
        emiAmount: salaryLoans.emiAmount,
        totalEmis: salaryLoans.totalEmis,
        paidEmis: salaryLoans.paidEmis,
        status: salaryLoans.status,
        approvedAt: salaryLoans.approvedAt,
        disbursedAt: salaryLoans.disbursedAt,
        closedAt: salaryLoans.closedAt,
        createdAt: salaryLoans.createdAt,
        updatedAt: salaryLoans.updatedAt,
      })
      .from(salaryLoans)
      .where(and(...conditions))
      .orderBy(asc(salaryLoans.id))
      .limit(BATCH_SIZE);
  }

  private async fetchBonuses(orgId: string, userId: string, afterId?: number) {
    const conditions = [eq(bonuses.orgId, orgId), eq(bonuses.userId, userId)];
    if (afterId !== undefined) conditions.push(gt(bonuses.id, afterId));
    return this.db
      .select({
        id: bonuses.id,
        type: bonuses.type,
        amount: bonuses.amount,
        amountCents: bonuses.amountCents,
        reason: bonuses.reason,
        month: bonuses.month,
        taxable: bonuses.taxable,
        status: bonuses.status,
        approvedAt: bonuses.approvedAt,
        createdAt: bonuses.createdAt,
      })
      .from(bonuses)
      .where(and(...conditions))
      .orderBy(asc(bonuses.id))
      .limit(BATCH_SIZE);
  }

  private async fetchFnfSettlements(
    orgId: string,
    userId: string,
    afterId?: number,
  ) {
    const conditions = [
      eq(fnfSettlements.orgId, orgId),
      eq(fnfSettlements.userId, userId),
    ];
    if (afterId !== undefined) conditions.push(gt(fnfSettlements.id, afterId));
    return this.db
      .select({
        id: fnfSettlements.id,
        basicDues: fnfSettlements.basicDues,
        leaveEncashment: fnfSettlements.leaveEncashment,
        bonusDue: fnfSettlements.bonusDue,
        deductions: fnfSettlements.deductions,
        loanRecovery: fnfSettlements.loanRecovery,
        netPayable: fnfSettlements.netPayable,
        status: fnfSettlements.status,
        notes: fnfSettlements.notes,
        reimbursementsDue: fnfSettlements.reimbursementsDue,
        assetRecovery: fnfSettlements.assetRecovery,
        noticeRecovery: fnfSettlements.noticeRecovery,
        otherDeductions: fnfSettlements.otherDeductions,
        statementPublishedAt: fnfSettlements.statementPublishedAt,
        createdAt: fnfSettlements.createdAt,
        updatedAt: fnfSettlements.updatedAt,
      })
      .from(fnfSettlements)
      .where(and(...conditions))
      .orderBy(asc(fnfSettlements.id))
      .limit(BATCH_SIZE);
  }

  private async fetchAssetReturns(
    orgId: string,
    userId: string,
    afterId?: number,
  ) {
    const conditions = [
      eq(assetReturns.orgId, orgId),
      eq(assetReturns.userId, userId),
    ];
    if (afterId !== undefined) conditions.push(gt(assetReturns.id, afterId));
    return this.db
      .select({
        id: assetReturns.id,
        assetId: assetReturns.assetId,
        assetName: assetReturns.assetName,
        status: assetReturns.status,
        returnedAt: assetReturns.returnedAt,
        condition: assetReturns.condition,
        notes: assetReturns.notes,
        createdAt: assetReturns.createdAt,
      })
      .from(assetReturns)
      .where(and(...conditions))
      .orderBy(asc(assetReturns.id))
      .limit(BATCH_SIZE);
  }
}
