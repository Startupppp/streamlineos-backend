import {
  getLeaveRequestEmailTemplate,
  getLeaveStatusUpdateEmailTemplate,
  getLeaveCancellationEmailTemplate,
  getDocumentExpiryReminderEmailTemplate,
  getResignationSubmittedEmailTemplate,
  getResignationApprovedEmailTemplate,
  getTerminationEmailTemplate,
} from "../index";
import { BASE_URL, EMAIL_TEMPLATE_VERSION, defineTemplateFamily } from "./_shared";

export const hrLeaveTemplates = defineTemplateFamily({
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
        `${BASE_URL()}/hr/leaves`,
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
      getDocumentExpiryReminderEmailTemplate(
        "Priya Sharma",
        "Passport",
        "Identity",
        "30 Apr 2026",
        14,
        `${BASE_URL()}/hr/documents`,
      ),
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
        `${BASE_URL()}/hr/exit`,
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
        `${BASE_URL()}/hr/exit`,
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
}, EMAIL_TEMPLATE_VERSION);
