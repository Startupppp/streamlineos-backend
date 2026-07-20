import {
  getVerificationEmailTemplate,
  getMagicLinkEmailTemplate,
  getWelcomeEmailTemplate,
  getAccountDeactivationEmailTemplate,
  getAccountLockedEmailTemplate,
  getEmailOtpTemplate,
  getInvitationEmailTemplate,
  getHolidayAnnouncementEmailTemplate,
  getCompanyAnnouncementEmailTemplate,
  getLeaveRequestEmailTemplate,
  getLeaveStatusUpdateEmailTemplate,
  getLeaveCancellationEmailTemplate,
  getDocumentExpiryReminderEmailTemplate,
  getResignationSubmittedEmailTemplate,
  getResignationApprovedEmailTemplate,
  getTerminationEmailTemplate,
  getExpenseSubmittedEmailTemplate,
  getExpenseApprovedEmailTemplate,
  getExpenseRejectedEmailTemplate,
  getExpensePaidEmailTemplate,
  getProjectAssignmentEmailTemplate,
  getTicketAssignmentEmailTemplate,
  getTicketReviewRequestEmailTemplate,
  getTicketChangesRequestedEmailTemplate,
  getClientInvestmentEmailTemplate,
  getLeadStatusChangeEmailTemplate,
  getLeadDistributionEmailTemplate,
  getCandidateRejectionEmail,
  getOfferDeadlineReminderEmail,
  getInterviewNoShowRescheduleEmail,
  getCandidateDocumentRolloutEmail,
  getInterviewInviteEmail,
  getSelfScheduleBookingEmail,
  getBookingConfirmationEmail,
  getCandidateFeedbackEmail,
  getPayslipEmailTemplate,
  getContactAdminNotificationEmail,
  getContactAutoreplyEmail,
  getContactReplyEmail,
  getTrialReminderEmail,
  getWeeklyAttendanceReportTemplate,
  getMonthlyExpenseReportTemplate,
  getWeeklyRecapEmailTemplate,
  getTaskAssignedEmailTemplate,
  getDealStageChangeEmailTemplate,
  getLeadAssignedEmailTemplate,
  getReviewAssignedEmailTemplate,
  getAssetAssignedEmailTemplate,
  getOnboardingWelcomeEmailTemplate,
  getOnboardingTaskEmailTemplate,
  getOnboardingCompleteEmployeeEmailTemplate,
  getOnboardingCompleteHrEmailTemplate,
  getTicketCreatedEmailTemplate,
  getTicketReplyEmailTemplate,
  getTicketStatusEmailTemplate,
  getHelpdeskTicketEmailTemplate,
  getWorkLogApprovedEmailTemplate,
  getWorkLogRejectedEmailTemplate,
  getOnboardingReminderEmailTemplate,
} from "./index";
import { getBrandName, getBrandUrl } from "../branding";

const BASE_URL = getBrandUrl();
const BRAND = getBrandName();

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
    subject: "Verify your email address",
    generateHtml: () => getVerificationEmailTemplate(`${BASE_URL}/verify-email?token=test-token`),
  },
  "auth.magic_link": {
    category: "Auth",
    name: "Magic Link Sign-In",
    subject: "Your sign-in link",
    generateHtml: () => getMagicLinkEmailTemplate(`${BASE_URL}/magic-link?token=test-token`),
  },
  "auth.welcome": {
    category: "Auth",
    name: "Welcome / Account Created",
    subject: `Your ${BRAND} account is ready`,
    generateHtml: () =>
      getWelcomeEmailTemplate("Priya Sharma", "priya@acme.in", `${BASE_URL}/setup?token=test-token`),
  },
  "auth.account_deactivated": {
    category: "Auth",
    name: "Account Deactivated",
    subject: "Your account has been deactivated",
    generateHtml: () => getAccountDeactivationEmailTemplate("Priya Sharma", "HR Admin", "Account closure requested"),
  },
  "auth.account_locked": {
    category: "Auth",
    name: "Account Locked",
    subject: "Your account is temporarily locked",
    generateHtml: () => getAccountLockedEmailTemplate("Priya Sharma"),
  },
  "auth.otp": {
    category: "Auth",
    name: "Sign-In OTP",
    subject: "Your sign-in code",
    generateHtml: () => getEmailOtpTemplate("482917"),
  },

  "org.invitation": {
    category: "Organization",
    name: "Team Invitation",
    subject: "You've been invited to join Acme Corp",
    generateHtml: () => getInvitationEmailTemplate(`${BASE_URL}/invitation/tok123`, "Acme Corp", "Rahul Verma"),
  },
  "org.holiday": {
    category: "Organization",
    name: "Holiday Announcement",
    subject: "Upcoming holiday: Diwali",
    generateHtml: () =>
      getHolidayAnnouncementEmailTemplate("Diwali", "Mon, 20 Oct 2025", "Office closed for Diwali."),
  },
  "org.announcement": {
    category: "Organization",
    name: "Company Announcement",
    subject: "Announcement: New HR Policy",
    generateHtml: () =>
      getCompanyAnnouncementEmailTemplate(
        "New HR Policy",
        "Effective 1 Aug 2025, leave requests must be submitted 5 working days in advance.",
        "Rahul Verma",
      ),
  },

  "hr.leave_request": {
    category: "HR Leave",
    name: "Leave Request (to approver)",
    subject: "Leave request from Priya Sharma",
    generateHtml: () =>
      getLeaveRequestEmailTemplate(
        "Rahul Verma",
        "Priya Sharma",
        "Casual Leave",
        "Mon, 20 Apr 2026",
        "Wed, 22 Apr 2026",
        "Attending a family function.",
        `${BASE_URL}/hr/leaves`,
      ),
  },
  "hr.leave_approved": {
    category: "HR Leave",
    name: "Leave Approved",
    subject: "Your leave request was approved",
    generateHtml: () =>
      getLeaveStatusUpdateEmailTemplate(
        "Priya Sharma",
        "Casual Leave",
        "Mon, 20 Apr 2026",
        "Wed, 22 Apr 2026",
        "APPROVED",
        "Rahul Verma",
      ),
  },
  "hr.leave_rejected": {
    category: "HR Leave",
    name: "Leave Rejected",
    subject: "Your leave request was rejected",
    generateHtml: () =>
      getLeaveStatusUpdateEmailTemplate(
        "Priya Sharma",
        "Casual Leave",
        "Mon, 20 Apr 2026",
        "Wed, 22 Apr 2026",
        "REJECTED",
        "Rahul Verma",
        "Insufficient leave balance.",
      ),
  },
  "hr.leave_cancelled": {
    category: "HR Leave",
    name: "Leave Cancellation",
    subject: "Leave request cancelled by Priya Sharma",
    generateHtml: () =>
      getLeaveCancellationEmailTemplate(
        "Rahul Verma",
        "Priya Sharma",
        "Casual Leave",
        "Mon, 20 Apr 2026",
        "Wed, 22 Apr 2026",
      ),
  },
  "hr.doc_expiry": {
    category: "HR Leave",
    name: "Document Expiry Reminder",
    subject: "Action needed: Passport expires soon",
    generateHtml: () =>
      getDocumentExpiryReminderEmailTemplate("Priya Sharma", "Passport", "Identity", "30 Apr 2026", 14, `${BASE_URL}/hr/documents`),
  },
  "hr.resignation_submitted": {
    category: "HR Leave",
    name: "Resignation Submitted",
    subject: "Resignation submitted by Priya Sharma",
    generateHtml: () =>
      getResignationSubmittedEmailTemplate(
        "Rahul Verma",
        "Priya Sharma",
        "Software Engineer",
        "Mon, 12 Apr 2026",
        "Fri, 12 Jun 2026",
        60,
        "Pursuing a new opportunity.",
        `${BASE_URL}/hr/exit`,
      ),
  },
  "hr.resignation_approved": {
    category: "HR Leave",
    name: "Resignation Accepted",
    subject: "Your resignation has been accepted",
    generateHtml: () =>
      getResignationApprovedEmailTemplate(
        "Priya Sharma",
        "Rahul Verma",
        "Fri, 12 Jun 2026",
        60,
        "Mon, 12 Apr 2026",
        `${BASE_URL}/hr/exit`,
      ),
  },
  "hr.termination": {
    category: "HR Leave",
    name: "Termination Notice",
    subject: "Notice of employment termination",
    generateHtml: () =>
      getTerminationEmailTemplate(
        "Priya Sharma",
        "Software Engineer",
        "Fri, 30 May 2026",
        "Rahul Verma",
        "Restructuring",
        "hr@acme.in",
      ),
  },

  "expense.submitted": {
    category: "HR Expense",
    name: "Expense Submitted",
    subject: "New expense claim from Priya Sharma",
    generateHtml: () =>
      getExpenseSubmittedEmailTemplate(
        "Rahul Verma",
        "Priya Sharma",
        "Travel",
        "1,500",
        "Mumbai to Pune cab",
        `${BASE_URL}/hr/expenses`,
      ),
  },
  "expense.approved": {
    category: "HR Expense",
    name: "Expense Approved",
    subject: "Your expense claim was approved",
    generateHtml: () => getExpenseApprovedEmailTemplate("Priya Sharma", "Travel", "1,500", "Rahul Verma"),
  },
  "expense.rejected": {
    category: "HR Expense",
    name: "Expense Rejected",
    subject: "Your expense claim was rejected",
    generateHtml: () =>
      getExpenseRejectedEmailTemplate("Priya Sharma", "Travel", "1,500", "Rahul Verma", "Receipt not attached."),
  },
  "expense.paid": {
    category: "HR Expense",
    name: "Expense Reimbursed",
    subject: "Your expense reimbursement was paid",
    generateHtml: () => getExpensePaidEmailTemplate("Priya Sharma", "Travel", "1,500", "TXN-TEST-001"),
  },

  "project.assigned": {
    category: "Projects",
    name: "Project Assignment",
    subject: "You've been added to Phoenix Platform",
    generateHtml: () =>
      getProjectAssignmentEmailTemplate(
        "Priya Sharma",
        "Phoenix Platform",
        "PHX-001",
        `${BASE_URL}/projects/1`,
        "Rahul Verma",
      ),
  },
  "project.ticket_assigned": {
    category: "Projects",
    name: "Ticket Assigned",
    subject: "Ticket assigned: Fix login redirect",
    generateHtml: () =>
      getTicketAssignmentEmailTemplate(
        "Priya Sharma",
        "Fix login redirect",
        "BUG",
        "HIGH",
        "Phoenix Platform",
        `${BASE_URL}/projects/1?ticket=42`,
        "Rahul Verma",
      ),
  },
  "project.review_request": {
    category: "Projects",
    name: "Ticket Review Request",
    subject: "Ready for review: Add export CSV",
    generateHtml: () =>
      getTicketReviewRequestEmailTemplate(
        "Rahul Verma",
        "Add export CSV",
        "FEATURE",
        "Phoenix Platform",
        `${BASE_URL}/projects/1?ticket=43`,
        "Priya Sharma",
        "All edge cases handled. Please review.",
      ),
  },
  "project.changes_requested": {
    category: "Projects",
    name: "Changes Requested",
    subject: "Changes requested: Add export CSV",
    generateHtml: () =>
      getTicketChangesRequestedEmailTemplate(
        "Priya Sharma",
        "Add export CSV",
        "Phoenix Platform",
        `${BASE_URL}/projects/1?ticket=43`,
        "Rahul Verma",
        "Please handle empty state on the export dialog.",
      ),
  },

  "crm.client_investment": {
    category: "CRM",
    name: "Client Investment Recorded",
    subject: "Investment recorded for Acme Corp",
    generateHtml: () =>
      getClientInvestmentEmailTemplate({
        recipientName: "Rahul Verma",
        clientName: "Acme Corp",
        amount: "5,00,000",
        date: "Mon, 7 Jul 2026",
        recordedBy: "Priya Sharma",
        clientUrl: `${BASE_URL}/crm/clients/1`,
      }).html,
  },
  "crm.lead_status_change": {
    category: "CRM",
    name: "Lead Status Change",
    subject: "Lead status updated: Raj Industries",
    generateHtml: () =>
      getLeadStatusChangeEmailTemplate({
        recipientName: "Rahul Verma",
        leadName: "Raj Industries",
        fromStatus: "New",
        toStatus: "Qualified",
        leadUrl: `${BASE_URL}/crm/leads/5`,
      }).html,
  },
  "crm.lead_distribution": {
    category: "CRM",
    name: "Lead Distribution",
    subject: "3 leads assigned to you",
    generateHtml: () =>
      getLeadDistributionEmailTemplate({
        recipientName: "Priya Sharma",
        assignerName: "Rahul Verma",
        leadCount: 3,
        leadsUrl: `${BASE_URL}/crm/leads`,
      }).html,
  },

  "recruitment.rejection": {
    category: "Recruitment",
    name: "Candidate Rejection",
    subject: "Update on your application to Acme Corp",
    generateHtml: () =>
      getCandidateRejectionEmail({
        candidateName: "Arjun Kapoor",
        jobTitle: "Senior Frontend Engineer",
        companyName: "Acme Corp",
      }).html,
  },
  "recruitment.offer_deadline": {
    category: "Recruitment",
    name: "Offer Deadline Reminder",
    subject: "Reminder: your offer expires on Fri, 18 Jul 2026",
    generateHtml: () =>
      getOfferDeadlineReminderEmail({
        candidateName: "Arjun Kapoor",
        orgName: "Acme Corp",
        designation: "Senior Frontend Engineer",
        deadlineLabel: "Fri, 18 Jul 2026",
        offerLink: `${BASE_URL}/offer/accept?token=test`,
      }).html,
  },
  "recruitment.no_show_reschedule": {
    category: "Recruitment",
    name: "Interview No-Show Reschedule",
    subject: "Let's reschedule your interview",
    generateHtml: () => getInterviewNoShowRescheduleEmail("Arjun Kapoor", "Acme Corp").html,
  },
  "recruitment.document_rollout": {
    category: "Recruitment",
    name: "Candidate Document Rollout",
    subject: "Your documents are ready — please review",
    generateHtml: () =>
      getCandidateDocumentRolloutEmail({
        candidateName: "Arjun Kapoor",
        documentLinks: [
          { title: "Offer Letter", url: `${BASE_URL}/docs/offer-letter` },
          { title: "NDA Agreement", url: `${BASE_URL}/docs/nda` },
        ],
      }).html,
  },

  "interview.invite_candidate": {
    category: "Interviews",
    name: "Interview Invite (Candidate)",
    subject: "Interview invitation — Senior Frontend Engineer at Acme Corp",
    generateHtml: () =>
      getInterviewInviteEmail({
        recipientName: "Arjun Kapoor",
        candidateName: "Arjun Kapoor",
        jobTitle: "Senior Frontend Engineer",
        companyName: "Acme Corp",
        scheduledAt: "Tue, 15 Jul 2026, 10:00 AM",
        durationMinutes: 60,
        format: "Video call",
        meetingLink: "https://meet.google.com/abc-def-ghi",
        recipientRole: "candidate",
      }).html,
  },
  "interview.invite_interviewer": {
    category: "Interviews",
    name: "Interview Invite (Interviewer)",
    subject: "You're interviewing Arjun Kapoor on Tue, 15 Jul 2026, 10:00 AM",
    generateHtml: () =>
      getInterviewInviteEmail({
        recipientName: "Priya Sharma",
        candidateName: "Arjun Kapoor",
        jobTitle: "Senior Frontend Engineer",
        companyName: "Acme Corp",
        scheduledAt: "Tue, 15 Jul 2026, 10:00 AM",
        durationMinutes: 60,
        format: "Video call",
        meetingLink: "https://meet.google.com/abc-def-ghi",
        recipientRole: "interviewer",
      }).html,
  },
  "interview.self_schedule": {
    category: "Interviews",
    name: "Self-Schedule Booking Link",
    subject: "Schedule your interview with Acme Corp",
    generateHtml: () =>
      getSelfScheduleBookingEmail(
        "Arjun Kapoor",
        `${BASE_URL}/schedule/abc123`,
        "Fri, 11 Jul 2026",
        "Acme Corp",
      ).html,
  },
  "interview.booking_confirmation": {
    category: "Interviews",
    name: "Booking Confirmation (Internal)",
    subject: "Arjun Kapoor scheduled their interview",
    generateHtml: () => getBookingConfirmationEmail("Arjun Kapoor", "Tue, 15 Jul 2026, 10:00 AM").html,
  },
  "interview.candidate_feedback": {
    category: "Interviews",
    name: "Candidate Feedback Request",
    subject: "How was your interview experience?",
    generateHtml: () =>
      getCandidateFeedbackEmail({
        candidateName: "Arjun Kapoor",
        orgName: "Acme Corp",
        scheduledAt: new Date("2026-07-15T10:00:00+05:30"),
      }).html,
  },

  "payroll.payslip": {
    category: "Payroll",
    name: "Payslip",
    subject: "Your payslip for June 2026",
    generateHtml: () =>
      getPayslipEmailTemplate({
        employeeName: "Priya Sharma",
        month: "June 2026",
        netSalary: "85,000",
        orgName: "Acme Corp",
      }).html,
  },

  "platform.contact_admin": {
    category: "Platform",
    name: "Contact Form — Admin Notification",
    subject: "New billing message from Rohan Mehta",
    generateHtml: () =>
      getContactAdminNotificationEmail({
        name: "Rohan Mehta",
        email: "rohan@example.com",
        topic: "billing",
        message: "I was charged twice for my subscription this month.",
        reference: "REF-2026-001",
        receivedAt: "Wed, 2 Jul 2026, 10:15 AM",
        company: "Mehta Solutions",
        inboxUrl: `${BASE_URL}/platform/inbox`,
      }).html,
  },
  "platform.contact_autoreply": {
    category: "Platform",
    name: "Contact Form — Customer Autoreply",
    subject: "We received your message",
    generateHtml: () =>
      getContactAutoreplyEmail({
        name: "Rohan Mehta",
        message: "I was charged twice for my subscription this month.",
      }).html,
  },
  "platform.contact_reply": {
    category: "Platform",
    name: "Contact Form — Staff Reply",
    subject: `Re: your billing message to ${BRAND}`,
    generateHtml: () =>
      getContactReplyEmail({
        name: "Rohan Mehta",
        replyBody:
          "Hi Rohan, we identified the duplicate charge and have initiated a refund. It should appear in 3-5 business days.",
        originalMessage: "I was charged twice for my subscription this month.",
        originalTopic: "billing",
      }).html,
  },
  "platform.trial_reminder": {
    category: "Platform",
    name: "Trial Reminder",
    subject: "Your trial ends in 5 days",
    generateHtml: () =>
      getTrialReminderEmail({
        orgName: "Mehta Solutions",
        daysLeft: 5,
        upgradeUrl: `${BASE_URL}/billing/upgrade`,
        plan: "Business",
      }).html,
  },

  "reports.weekly_attendance": {
    category: "Reports",
    name: "Weekly Attendance Report",
    subject: "Attendance report — week of 30 Jun 2026",
    generateHtml: () =>
      getWeeklyAttendanceReportTemplate("30 Jun – 4 Jul 2026", "Acme Corp", [
        {
          department: "Engineering",
          name: "Priya Sharma",
          totalHours: "42h 30m",
          autoCheckoutDays: 0,
          overtimeDays: 2,
          daysPresent: 5,
        },
        {
          department: "Sales",
          name: "Rahul Verma",
          totalHours: "38h 00m",
          autoCheckoutDays: 1,
          overtimeDays: 0,
          daysPresent: 5,
        },
      ]),
  },
  "reports.monthly_expense": {
    category: "Reports",
    name: "Monthly Expense Report",
    subject: "Expense report — June 2026",
    generateHtml: () =>
      getMonthlyExpenseReportTemplate(
        "June 2026",
        "Acme Corp",
        [
          {
            date: "2 Jun 2026",
            employeeName: "Priya Sharma",
            category: "Travel",
            amount: "1,500",
            currency: "INR",
            status: "APPROVED",
          },
          {
            date: "10 Jun 2026",
            employeeName: "Rahul Verma",
            category: "Meals",
            amount: "800",
            currency: "INR",
            status: "PAID",
          },
        ],
        {
          totalAmount: "2,300",
          totalCount: 2,
          pendingCount: 0,
          approvedCount: 1,
          paidCount: 1,
          rejectedCount: 0,
        },
      ),
  },
  "reports.weekly_recap": {
    category: "Reports",
    name: "Weekly Business Recap",
    subject: "Your week at Acme Corp",
    generateHtml: () =>
      getWeeklyRecapEmailTemplate({
        orgName: "Acme Corp",
        weekRange: "30 Jun – 4 Jul 2026",
        totalEmployees: 48,
        newLeads: 12,
        convertedLeads: 3,
        totalActivities: 27,
        openTickets: 5,
        closedTickets: 9,
        pendingLeaves: 2,
        topPerformers: [
          { name: "Rahul Verma", score: 142 },
          { name: "Sana Sheikh", score: 118 },
        ],
        pipelineSummary: [
          { status: "New", count: 8 },
          { status: "Qualified", count: 5 },
          { status: "Negotiation", count: 3 },
        ],
        aiNarrative: "Strong week with 3 deals converted and 12 new inbound leads.",
      }),
  },

  "notif.task_assigned": {
    category: "Notifications",
    name: "Task Assigned",
    subject: "Task assigned: Follow up with Raj Industries",
    generateHtml: () =>
      getTaskAssignedEmailTemplate(
        "Priya Sharma",
        "Follow up with Raj Industries",
        "Call",
        "Mon, 7 Jul 2026",
        "Rahul Verma",
        "Lead: Raj Industries",
      ),
  },
  "notif.deal_stage_change": {
    category: "Notifications",
    name: "Deal Stage Change",
    subject: "Deal stage updated: Phoenix Project",
    generateHtml: () =>
      getDealStageChangeEmailTemplate(
        "Priya Sharma",
        "Phoenix Project",
        "Proposal",
        "Negotiation",
        "12,00,000",
        "Rahul Verma",
        7,
      ),
  },
  "notif.lead_assigned": {
    category: "Notifications",
    name: "Lead Assigned",
    subject: "Lead assigned: Raj Industries",
    generateHtml: () =>
      getLeadAssignedEmailTemplate("Priya Sharma", "Raj Industries", "Inbound", "HOT", "Rahul Verma"),
  },
  "notif.review_assigned": {
    category: "Notifications",
    name: "Performance Review Assigned",
    subject: "Performance review assigned",
    generateHtml: () =>
      getReviewAssignedEmailTemplate("Priya Sharma", "Rahul Verma", "1 Apr 2026", "30 Jun 2026"),
  },
  "notif.asset_assigned": {
    category: "Notifications",
    name: "Asset Assigned",
    subject: "Asset assigned: MacBook Pro 14",
    generateHtml: () =>
      getAssetAssignedEmailTemplate("Priya Sharma", "MacBook Pro 14", "Laptop", "SN-MBP-2026-001"),
  },

  "notif.onboarding_welcome": {
    category: "Notifications",
    name: "Onboarding Welcome",
    subject: `Welcome to ${BRAND}`,
    generateHtml: () =>
      getOnboardingWelcomeEmailTemplate("Arjun Kapoor", "Junior Developer", "Mon, 7 Jul 2026", 6),
  },
  "notif.onboarding_task": {
    category: "Notifications",
    name: "Onboarding Tasks Assigned",
    subject: "Onboarding tasks assigned to you",
    generateHtml: () => getOnboardingTaskEmailTemplate("Priya Sharma", "Arjun Kapoor", "IT", 3),
  },
  "notif.onboarding_complete_employee": {
    category: "Notifications",
    name: "Onboarding Complete (Employee)",
    subject: "Onboarding complete",
    generateHtml: () => getOnboardingCompleteEmployeeEmailTemplate("Arjun Kapoor"),
  },
  "notif.onboarding_complete_hr": {
    category: "Notifications",
    name: "Onboarding Complete (HR)",
    subject: "Arjun Kapoor completed onboarding",
    generateHtml: () => getOnboardingCompleteHrEmailTemplate("Priya Sharma", "Arjun Kapoor"),
  },
  "notif.onboarding_reminder": {
    category: "Notifications",
    name: "Onboarding Reminder",
    subject: "Onboarding reminder",
    generateHtml: () => getOnboardingReminderEmailTemplate("Arjun Kapoor", 3, 6),
  },
  "notif.ticket_created": {
    category: "Notifications",
    name: "Support Ticket Created",
    subject: "New support ticket: Unable to export reports",
    generateHtml: () =>
      getTicketCreatedEmailTemplate("Priya Sharma", "Unable to export reports", "HIGH", "Rahul Verma", 101),
  },
  "notif.ticket_reply": {
    category: "Notifications",
    name: "Ticket Reply",
    subject: "New reply on ticket #101",
    generateHtml: () =>
      getTicketReplyEmailTemplate(
        "Rahul Verma",
        "Unable to export reports",
        101,
        "Priya Sharma",
        "We identified the root cause and a fix is being deployed shortly.",
      ),
  },
  "notif.ticket_status": {
    category: "Notifications",
    name: "Ticket Status Update",
    subject: "Ticket #101 status: RESOLVED",
    generateHtml: () =>
      getTicketStatusEmailTemplate("Rahul Verma", "Unable to export reports", 101, "RESOLVED", "Priya Sharma"),
  },
  "notif.helpdesk_ticket": {
    category: "Notifications",
    name: "Helpdesk Ticket",
    subject: "New helpdesk ticket: Laptop overheating",
    generateHtml: () =>
      getHelpdeskTicketEmailTemplate("Priya Sharma", "Laptop overheating", "Hardware", "MEDIUM", "Arjun Kapoor"),
  },
  "notif.work_log_approved": {
    category: "Notifications",
    name: "Work Log Approved",
    subject: "Your work log was approved",
    generateHtml: () => getWorkLogApprovedEmailTemplate("Priya Sharma", "30 Jun 2026", "Rahul Verma"),
  },
  "notif.work_log_rejected": {
    category: "Notifications",
    name: "Work Log Needs Changes",
    subject: "Your work log needs changes",
    generateHtml: () =>
      getWorkLogRejectedEmailTemplate(
        "Priya Sharma",
        "30 Jun 2026",
        "Rahul Verma",
        "Please add more detail on the task descriptions.",
      ),
  },
};
