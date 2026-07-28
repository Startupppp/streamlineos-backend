export {
  getVerificationEmailTemplate,
  getMagicLinkEmailTemplate,
  getWelcomeEmailTemplate,
  getAccountDeactivationEmailTemplate,
  getAccountLockedEmailTemplate,
  getEmailOtpTemplate,
} from "./auth";

export {
  getInvitationEmailTemplate,
  getHolidayAnnouncementEmailTemplate,
  getCompanyAnnouncementEmailTemplate,
} from "./organization";

export {
  getExpenseSubmittedEmailTemplate,
  getExpenseApprovedEmailTemplate,
  getExpenseRejectedEmailTemplate,
  getExpensePaidEmailTemplate,
} from "./expense";

export {
  getLeaveRequestEmailTemplate,
  getLeaveStatusUpdateEmailTemplate,
  getLeaveCancellationEmailTemplate,
  getResignationSubmittedEmailTemplate,
  getResignationApprovedEmailTemplate,
  getTerminationEmailTemplate,
  getDocumentExpiryReminderEmailTemplate,
} from "./hr";

export {
  getProjectAssignmentEmailTemplate,
  getTicketAssignmentEmailTemplate,
  getTicketReviewRequestEmailTemplate,
  getTicketChangesRequestedEmailTemplate,
} from "./project";

export {
  renderButton,
  renderKeyValueRows,
  renderCallout,
  renderBadge,
  renderFallbackLink,
  renderOtpCode,
} from "./components";
export type { Tone, ButtonVariant } from "./components";

export {
  getClientInvestmentEmailTemplate,
  getLeadStatusChangeEmailTemplate,
  getLeadDistributionEmailTemplate,
} from "./crm";

export {
  getCandidateRejectionEmail,
  getOfferDeadlineReminderEmail,
  getInterviewNoShowRescheduleEmail,
  getCandidateDocumentRolloutEmail,
} from "./recruitment";

export {
  getInterviewInviteEmail,
  getSelfScheduleBookingEmail,
  getBookingConfirmationEmail,
  getCandidateFeedbackEmail,
} from "./interviews";

export { getPayslipEmailTemplate } from "./payroll";
export type { PayslipEmailParams } from "./payroll";

export {
  getContactAdminNotificationEmail,
  getContactAutoreplyEmail,
  getContactReplyEmail,
  getTrialReminderEmail,
} from "./platform";
export type {
  ContactAdminEmailParams,
  ContactAutoreplyEmailParams,
  ContactReplyEmailParams,
  TrialReminderEmailParams,
} from "./platform";

export {
  getWeeklyAttendanceReportTemplate,
  getMonthlyExpenseReportTemplate,
  getWeeklyRecapEmailTemplate,
} from "./reports";
export type { MonthlyExpenseReportRow, WeeklyRecapData } from "./reports";

export {
  getTaskAssignedEmailTemplate,
  getDealStageChangeEmailTemplate,
  getLeadAssignedEmailTemplate,
  getReviewAssignedEmailTemplate,
  getAssetAssignedEmailTemplate,
} from "./notifications-crm-hr";

export {
  getOnboardingWelcomeEmailTemplate,
  getOnboardingTaskEmailTemplate,
  getOnboardingCompleteEmployeeEmailTemplate,
  getOnboardingCompleteHrEmailTemplate,
  getTicketCreatedEmailTemplate,
  getTicketReplyEmailTemplate,
  getTicketStatusEmailTemplate,
  getTicketEscalationEmailTemplate,
  type TicketEscalationLevel,
  getHelpdeskTicketEmailTemplate,
  getWorkLogApprovedEmailTemplate,
  getWorkLogRejectedEmailTemplate,
  getOnboardingReminderEmailTemplate,
} from "./notifications-misc";

export { generateMonthlyExpenseReportXlsx } from "./xlsx";

export {
  getSignEnvelopeInvitationEmailTemplate,
  getSignReminderEmailTemplate,
  getSignEnvelopeCompletedEmailTemplate,
  getSignEnvelopeDeclinedEmailTemplate,
  getSignEnvelopeVoidedEmailTemplate,
  getSignBulkJobCompletedEmailTemplate,
} from "./e-sign";
