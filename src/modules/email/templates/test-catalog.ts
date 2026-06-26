import {
  getVerificationEmailTemplate,
  getPasswordResetEmailTemplate,
  getWelcomeEmailTemplate,
  getPasswordChangeConfirmationEmailTemplate,
  getAccountDeactivationEmailTemplate,
  getAccountLockedEmailTemplate,
  getNewDeviceLoginEmailTemplate,
  getPasswordExpiryWarningEmailTemplate,
  getInvitationEmailTemplate,
  getHolidayAnnouncementEmailTemplate,
  getCompanyAnnouncementEmailTemplate,
  getLeaveRequestEmailTemplate,
  getLeaveStatusUpdateEmailTemplate,
  getLeaveCancellationEmailTemplate,
  getDocumentExpiryReminderEmailTemplate,
  getResignationSubmittedEmailTemplate,
  getResignationApprovedEmailTemplate,
  getExpenseSubmittedEmailTemplate,
  getExpenseApprovedEmailTemplate,
  getExpenseRejectedEmailTemplate,
  getExpensePaidEmailTemplate,
  getSelfReviewReminderEmail,
  getManagerReviewReminderEmail,
  getReviewPublishedEmail,
  getGoalSettingReminderEmail,
  getLeadWelcomeEmail,
  getFollowUpReminderEmail,
  getDealWonEmail,
  getSlaBreachAlertEmail,
  getClientOnboardingEmail,
  getProjectAssignmentEmailTemplate,
  getTicketAssignmentEmailTemplate,
  getTicketReviewRequestEmailTemplate,
  getTicketChangesRequestedEmailTemplate,
} from "./index";

const BASE_URL = process.env.NEXTAUTH_URL ?? "https://streamlineos.app";

export interface TemplateEntry {
  subject: string;
  generateHtml: () => string;
}

export const TEMPLATE_MAP: Record<string, TemplateEntry> = {
  "auth.verify": {
    subject: "Verify Your Email Address - StreamlineOS",
    generateHtml: () => getVerificationEmailTemplate(`${BASE_URL}/verify-email?token=test-token`),
  },
  "auth.password_reset": {
    subject: "Reset Your Password - StreamlineOS",
    generateHtml: () => getPasswordResetEmailTemplate(`${BASE_URL}/auth/reset-password?token=test-token`),
  },
  "auth.welcome": {
    subject: "Welcome to StreamlineOS — Set Up Your Account",
    generateHtml: () =>
      getWelcomeEmailTemplate("Test User", "test@example.com", `${BASE_URL}/setup-password?token=test-token`),
  },
  "auth.password_changed": {
    subject: "Password Changed Successfully - StreamlineOS",
    generateHtml: () => getPasswordChangeConfirmationEmailTemplate("Test User"),
  },
  "auth.account_deactivated": {
    subject: "Account Deactivated - StreamlineOS",
    generateHtml: () => getAccountDeactivationEmailTemplate("Test User", "HR Admin", "Test deactivation"),
  },
  "auth.account_locked": {
    subject: "Account Locked - StreamlineOS",
    generateHtml: () => getAccountLockedEmailTemplate("Test User"),
  },
  "auth.new_device": {
    subject: "New Device Sign-In Detected - StreamlineOS",
    generateHtml: () =>
      getNewDeviceLoginEmailTemplate("Test User", {
        userAgent: "Chrome on Windows",
        ipAddress: "127.0.0.1",
        time: new Date().toLocaleString("en-IN"),
      }),
  },
  "auth.password_expiry": {
    subject: "Your Password Expires in 7 Days - StreamlineOS",
    generateHtml: () => getPasswordExpiryWarningEmailTemplate("Test User", 7),
  },

  "org.invitation": {
    subject: "Invitation to join StreamlineOS",
    generateHtml: () => getInvitationEmailTemplate(`${BASE_URL}/invitation/tok123`, "StreamlineOS", "HR Admin"),
  },
  "org.holiday": {
    subject: "Holiday Tomorrow: Test Holiday - StreamlineOS",
    generateHtml: () => getHolidayAnnouncementEmailTemplate("Test Holiday", "Tomorrow", "Enjoy the holiday!"),
  },
  "org.announcement": {
    subject: "Announcement: Test Announcement - StreamlineOS",
    generateHtml: () =>
      getCompanyAnnouncementEmailTemplate("Test Announcement", "This is a test company announcement.", "HR Admin"),
  },

  "hr.leave_request": {
    subject: "Leave Request: Test Employee - StreamlineOS",
    generateHtml: () =>
      getLeaveRequestEmailTemplate(
        "HR Admin",
        "Test Employee",
        "Casual Leave",
        "20 Apr 2026",
        "22 Apr 2026",
        "Personal work.",
        `${BASE_URL}/hr/leaves`,
      ),
  },
  "hr.leave_approved": {
    subject: "Leave Request APPROVED: Casual Leave - StreamlineOS",
    generateHtml: () =>
      getLeaveStatusUpdateEmailTemplate(
        "Test Employee",
        "Casual Leave",
        "20 Apr 2026",
        "22 Apr 2026",
        "APPROVED",
        "HR Admin",
      ),
  },
  "hr.leave_rejected": {
    subject: "Leave Request REJECTED: Casual Leave - StreamlineOS",
    generateHtml: () =>
      getLeaveStatusUpdateEmailTemplate(
        "Test Employee",
        "Casual Leave",
        "20 Apr 2026",
        "22 Apr 2026",
        "REJECTED",
        "HR Admin",
        "Insufficient leave balance.",
      ),
  },
  "hr.leave_cancelled": {
    subject: "Leave Cancelled: Test Employee - StreamlineOS",
    generateHtml: () =>
      getLeaveCancellationEmailTemplate("HR Admin", "Test Employee", "Casual Leave", "20 Apr 2026", "22 Apr 2026"),
  },
  "hr.doc_expiry": {
    subject: "Document Expiring Soon: Test Document",
    generateHtml: () =>
      getDocumentExpiryReminderEmailTemplate("Test Employee", "Test Document", "Identity", "30 Apr 2026", 12),
  },
  "hr.resignation_submitted": {
    subject: "Resignation Submitted: Test Employee - StreamlineOS",
    generateHtml: () =>
      getResignationSubmittedEmailTemplate(
        "HR Admin",
        "Test Employee",
        "Associate",
        "12 Apr 2026",
        "12 May 2026",
        30,
        "Pursuing higher studies.",
        `${BASE_URL}/hr/exit`,
      ),
  },
  "hr.resignation_approved": {
    subject: "Resignation Accepted - StreamlineOS",
    generateHtml: () =>
      getResignationApprovedEmailTemplate(
        "Test Employee",
        "HR Admin",
        "12 May 2026",
        30,
        "12 Apr 2026",
        `${BASE_URL}/hr/exit`,
      ),
  },

  "expense.submitted": {
    subject: "New Expense Claim from Test Employee",
    generateHtml: () =>
      getExpenseSubmittedEmailTemplate(
        "HR Admin",
        "Test Employee",
        "Travel",
        "1,500",
        "Test expense",
        `${BASE_URL}/hr/expenses`,
      ),
  },
  "expense.approved": {
    subject: "Expense Claim Approved - ₹1,500",
    generateHtml: () => getExpenseApprovedEmailTemplate("Test Employee", "Travel", "1,500", "HR Admin"),
  },
  "expense.rejected": {
    subject: "Expense Claim Rejected - ₹1,500",
    generateHtml: () =>
      getExpenseRejectedEmailTemplate("Test Employee", "Travel", "1,500", "HR Admin", "Receipt not attached."),
  },
  "expense.paid": {
    subject: "Expense Reimbursed - ₹1,500",
    generateHtml: () => getExpensePaidEmailTemplate("Test Employee", "Travel", "1,500", "TXN-TEST-001"),
  },

  "appraisal.self_review": {
    subject: "Self-Review Due: Q1 FY2026 Performance Review",
    generateHtml: () =>
      getSelfReviewReminderEmail(
        "Test Employee",
        "Q1 FY2026 Performance Review",
        "30 Apr 2026",
        `${BASE_URL}/hr/appraisals/review`,
      ),
  },
  "appraisal.manager_review": {
    subject: "3 Pending Reviews — Q1 FY2026 Performance Review",
    generateHtml: () =>
      getManagerReviewReminderEmail("HR Admin", 3, "Q1 FY2026 Performance Review", `${BASE_URL}/hr/appraisals`),
  },
  "appraisal.published": {
    subject: "Your Q1 FY2026 Review is Published",
    generateHtml: () =>
      getReviewPublishedEmail(
        "Test Employee",
        "Q1 FY2026 Performance Review",
        "4.0 / 5 — Meets Expectations",
        `${BASE_URL}/hr/appraisals/result`,
      ),
  },
  "appraisal.goal_setting": {
    subject: "Set Your Q2 FY2026 Goals",
    generateHtml: () =>
      getGoalSettingReminderEmail("Test Employee", "Q2 FY2026", "15 May 2026", `${BASE_URL}/hr/appraisals/goals`),
  },

  "crm.lead_welcome": {
    subject: "Thank you for contacting StreamlineOS",
    generateHtml: () => getLeadWelcomeEmail("Test Lead", "StreamlineOS", "info@streamlineos.app", BASE_URL),
  },
  "crm.follow_up": {
    subject: "Follow up with Test Lead",
    generateHtml: () => getFollowUpReminderEmail("Test Rep", "Test Lead", 7, `${BASE_URL}/crm/leads/1`),
  },
  "crm.deal_won": {
    subject: "Deal Won: Test Deal — ₹10,00,000",
    generateHtml: () => getDealWonEmail("Team", "Test Deal", "₹10,00,000", "Test Rep", `${BASE_URL}/crm/deals`),
  },
  "crm.sla_breach": {
    subject: "SLA Breach: Test Lead",
    generateHtml: () => getSlaBreachAlertEmail("Test Rep", "Test Lead", 4, `${BASE_URL}/crm/leads/1`),
  },
  "crm.client_onboarding": {
    subject: "Welcome to StreamlineOS",
    generateHtml: () =>
      getClientOnboardingEmail("Test Client", "StreamlineOS", "Test Rep", `${BASE_URL}/client-portal`),
  },

  "project.assigned": {
    subject: "Added to Project: Test Project - StreamlineOS",
    generateHtml: () =>
      getProjectAssignmentEmailTemplate("Test Employee", "Test Project", "TST-001", `${BASE_URL}/projects/1`, "HR Admin"),
  },
  "project.ticket_assigned": {
    subject: "Ticket Assigned: Test ticket - StreamlineOS",
    generateHtml: () =>
      getTicketAssignmentEmailTemplate(
        "Test Employee",
        "Test ticket",
        "BUG",
        "MEDIUM",
        "Test Project",
        `${BASE_URL}/projects/1?ticket=1`,
        "HR Admin",
      ),
  },
  "project.review_request": {
    subject: "Review Requested: Test ticket - StreamlineOS",
    generateHtml: () =>
      getTicketReviewRequestEmailTemplate(
        "HR Admin",
        "Test ticket",
        "BUG",
        "Test Project",
        `${BASE_URL}/projects/1?ticket=1`,
        "Test Employee",
        "Please review my changes.",
      ),
  },
  "project.changes_requested": {
    subject: "Changes Requested: Test ticket - StreamlineOS",
    generateHtml: () =>
      getTicketChangesRequestedEmailTemplate(
        "Test Employee",
        "Test ticket",
        "Test Project",
        `${BASE_URL}/projects/1?ticket=1`,
        "HR Admin",
        "Please fix the edge case on mobile.",
      ),
  },
};
