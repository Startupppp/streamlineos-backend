import {
  getVerificationEmailTemplate,
  getPasswordResetEmailTemplate,
  getWelcomeEmailTemplate,
  getPasswordChangeConfirmationEmailTemplate,
  getAccountDeactivationEmailTemplate,
  getAccountLockedEmailTemplate,
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
  category: string;
  name: string;
  subject: string;
  generateHtml: () => string;
}

export const TEMPLATE_MAP: Record<string, TemplateEntry> = {
  "auth.verify": {
    category: "Auth",
    name: "Email Verification",
    subject: "Verify Your Email Address - StreamlineOS",
    generateHtml: () => getVerificationEmailTemplate(`${BASE_URL}/verify-email?token=test-token`),
  },
  "auth.password_reset": {
    category: "Auth",
    name: "Password Reset",
    subject: "Reset Your Password - StreamlineOS",
    generateHtml: () => getPasswordResetEmailTemplate(`${BASE_URL}/auth/reset-password?token=test-token`),
  },
  "auth.welcome": {
    category: "Auth",
    name: "Welcome / Account Created",
    subject: "Welcome to StreamlineOS — Set Up Your Account",
    generateHtml: () =>
      getWelcomeEmailTemplate("Test User", "test@example.com", `${BASE_URL}/setup-password?token=test-token`),
  },
  "auth.password_changed": {
    category: "Auth",
    name: "Password Changed Confirmation",
    subject: "Password Changed Successfully - StreamlineOS",
    generateHtml: () => getPasswordChangeConfirmationEmailTemplate("Test User"),
  },
  "auth.account_deactivated": {
    category: "Auth",
    name: "Account Deactivated",
    subject: "Account Deactivated - StreamlineOS",
    generateHtml: () => getAccountDeactivationEmailTemplate("Test User", "HR Admin", "Test deactivation"),
  },
  "auth.account_locked": {
    category: "Auth",
    name: "Account Locked",
    subject: "Account Locked - StreamlineOS",
    generateHtml: () => getAccountLockedEmailTemplate("Test User"),
  },

  "org.invitation": {
    category: "Organization",
    name: "Team Invitation",
    subject: "Invitation to join StreamlineOS",
    generateHtml: () => getInvitationEmailTemplate(`${BASE_URL}/invitation/tok123`, "StreamlineOS", "HR Admin"),
  },
  "org.holiday": {
    category: "Organization",
    name: "Holiday Announcement",
    subject: "Holiday Tomorrow: Test Holiday - StreamlineOS",
    generateHtml: () => getHolidayAnnouncementEmailTemplate("Test Holiday", "Tomorrow", "Enjoy the holiday!"),
  },
  "org.announcement": {
    category: "Organization",
    name: "Company Announcement",
    subject: "Announcement: Test Announcement - StreamlineOS",
    generateHtml: () =>
      getCompanyAnnouncementEmailTemplate("Test Announcement", "This is a test company announcement.", "HR Admin"),
  },

  "hr.leave_request": {
    category: "HR Leave",
    name: "Leave Request (to approver)",
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
    category: "HR Leave",
    name: "Leave Approved",
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
    category: "HR Leave",
    name: "Leave Rejected",
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
    category: "HR Leave",
    name: "Leave Cancellation",
    subject: "Leave Cancelled: Test Employee - StreamlineOS",
    generateHtml: () =>
      getLeaveCancellationEmailTemplate("HR Admin", "Test Employee", "Casual Leave", "20 Apr 2026", "22 Apr 2026"),
  },
  "hr.doc_expiry": {
    category: "HR Leave",
    name: "Document Expiry Reminder",
    subject: "Document Expiring Soon: Test Document",
    generateHtml: () =>
      getDocumentExpiryReminderEmailTemplate("Test Employee", "Test Document", "Identity", "30 Apr 2026", 12),
  },
  "hr.resignation_submitted": {
    category: "HR Leave",
    name: "Resignation Submitted",
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
    category: "HR Leave",
    name: "Resignation Accepted",
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
    category: "HR Expense",
    name: "Expense Submitted",
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
    category: "HR Expense",
    name: "Expense Approved",
    subject: "Expense Claim Approved - ₹1,500",
    generateHtml: () => getExpenseApprovedEmailTemplate("Test Employee", "Travel", "1,500", "HR Admin"),
  },
  "expense.rejected": {
    category: "HR Expense",
    name: "Expense Rejected",
    subject: "Expense Claim Rejected - ₹1,500",
    generateHtml: () =>
      getExpenseRejectedEmailTemplate("Test Employee", "Travel", "1,500", "HR Admin", "Receipt not attached."),
  },
  "expense.paid": {
    category: "HR Expense",
    name: "Expense Reimbursed",
    subject: "Expense Reimbursed - ₹1,500",
    generateHtml: () => getExpensePaidEmailTemplate("Test Employee", "Travel", "1,500", "TXN-TEST-001"),
  },

  "appraisal.self_review": {
    category: "Appraisal",
    name: "Self-Review Reminder",
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
    category: "Appraisal",
    name: "Manager Review Reminder",
    subject: "3 Pending Reviews — Q1 FY2026 Performance Review",
    generateHtml: () =>
      getManagerReviewReminderEmail("HR Admin", 3, "Q1 FY2026 Performance Review", `${BASE_URL}/hr/appraisals`),
  },
  "appraisal.published": {
    category: "Appraisal",
    name: "Review Published",
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
    category: "Appraisal",
    name: "Goal Setting Reminder",
    subject: "Set Your Q2 FY2026 Goals",
    generateHtml: () =>
      getGoalSettingReminderEmail("Test Employee", "Q2 FY2026", "15 May 2026", `${BASE_URL}/hr/appraisals/goals`),
  },

  "crm.lead_welcome": {
    category: "CRM",
    name: "Lead Welcome Email",
    subject: "Thank you for contacting StreamlineOS",
    generateHtml: () => getLeadWelcomeEmail("Test Lead", "StreamlineOS", "info@streamlineos.app", BASE_URL),
  },
  "crm.follow_up": {
    category: "CRM",
    name: "Follow-Up Reminder (internal)",
    subject: "Follow up with Test Lead",
    generateHtml: () => getFollowUpReminderEmail("Test Rep", "Test Lead", 7, `${BASE_URL}/crm/leads/1`),
  },
  "crm.deal_won": {
    category: "CRM",
    name: "Deal Won (team notification)",
    subject: "Deal Won: Test Deal — ₹10,00,000",
    generateHtml: () => getDealWonEmail("Team", "Test Deal", "₹10,00,000", "Test Rep", `${BASE_URL}/crm/deals`),
  },
  "crm.sla_breach": {
    category: "CRM",
    name: "SLA Breach Alert",
    subject: "SLA Breach: Test Lead",
    generateHtml: () => getSlaBreachAlertEmail("Test Rep", "Test Lead", 4, `${BASE_URL}/crm/leads/1`),
  },
  "crm.client_onboarding": {
    category: "CRM",
    name: "Client Onboarding Email",
    subject: "Welcome to StreamlineOS",
    generateHtml: () =>
      getClientOnboardingEmail("Test Client", "StreamlineOS", "Test Rep", `${BASE_URL}/client-portal`),
  },

  "project.assigned": {
    category: "Projects",
    name: "Project Assignment",
    subject: "Added to Project: Test Project - StreamlineOS",
    generateHtml: () =>
      getProjectAssignmentEmailTemplate("Test Employee", "Test Project", "TST-001", `${BASE_URL}/projects/1`, "HR Admin"),
  },
  "project.ticket_assigned": {
    category: "Projects",
    name: "Ticket Assigned",
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
    category: "Projects",
    name: "Ticket Review Request",
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
    category: "Projects",
    name: "Changes Requested",
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
