import {
  IN_APP,
  IN_APP_EMAIL,
  IN_APP_PUSH_EMAIL,
  URGENT_ALLOWED_CHANNELS,
} from "./notification-event-channel-policy";
import { notificationEvent } from "./notification-event-factory";

const e = notificationEvent;
const IA = IN_APP;
const IA_EMAIL = IN_APP_EMAIL;
const IA_PUSH_EMAIL = IN_APP_PUSH_EMAIL;
const ALLOWED_URGENT = URGENT_ALLOWED_CHANNELS;

export const HR_NOTIFICATION_EVENTS = [
  e("hr.holiday.announced", "hr", "HRMS", "Holiday announced", {
    defaultChannels: IA_EMAIL,
  }),
  e("hr.asset.assigned", "hr", "HRMS", "Asset assigned", {
    defaultChannels: IA_EMAIL,
  }),
  e("hr.helpdesk.ticket_created", "hr", "WORKFLOW", "HR helpdesk ticket created", {
    defaultChannels: IA_EMAIL,
  }),
  e("hr.helpdesk.ticket_assigned", "hr", "WORKFLOW", "HR helpdesk ticket assigned", {
    defaultChannels: IA_EMAIL,
  }),
  e("hr.helpdesk.ticket_status_changed", "hr", "WORKFLOW", "HR helpdesk ticket status changed", {
    defaultChannels: IA,
  }),
  e("hr.resignation.submitted", "hr", "WORKFLOW", "Resignation submitted", {
    defaultChannels: IA_EMAIL,
  }),
  e("hr.resignation.approved", "hr", "WORKFLOW", "Resignation approved", {
    defaultType: "SUCCESS",
    defaultChannels: IA_EMAIL,
  }),
  e("hr.onboarding.started", "hr", "WORKFLOW", "Onboarding started", {
    defaultChannels: IA_EMAIL,
  }),
  e("hr.onboarding.completed", "hr", "WORKFLOW", "Onboarding completed", {
    defaultType: "SUCCESS",
    defaultChannels: IA_EMAIL,
  }),
  e("hr.performance.review_assigned", "hr", "HRMS", "Performance review assigned", {
    defaultChannels: IA_EMAIL,
  }),
  e("hr.leave.cancelled", "hr", "HRMS", "Leave cancelled", {
    defaultType: "WARNING",
    defaultChannels: IA_EMAIL,
  }),
  e("hr.worklog.approved", "hr", "HRMS", "Work log approved", {
    defaultType: "SUCCESS",
    defaultChannels: IA_EMAIL,
  }),
  e("hr.worklog.rejected", "hr", "HRMS", "Work log rejected", {
    defaultType: "WARNING",
    defaultChannels: IA_EMAIL,
  }),
  e("hr.leave.requested", "hr", "WORKFLOW", "Leave request submitted", {
    defaultChannels: IA_EMAIL,
  }),
  e("hr.leave.approved", "hr", "HRMS", "Leave approved", {
    defaultType: "SUCCESS",
    defaultChannels: IA_EMAIL,
  }),
  e("hr.leave.rejected", "hr", "HRMS", "Leave rejected", {
    defaultType: "WARNING",
    defaultChannels: IA_EMAIL,
  }),
  e("hr.attendance.missing", "hr", "HRMS", "Missing attendance", {
    defaultChannels: IA,
    ttlSeconds: 86400,
  }),
  e("hr.document.expiring", "hr", "HRMS", "Document expiring", {
    defaultPriority: "HIGH",
    defaultChannels: IA_EMAIL,
  }),
  e("hr.announcement.created", "hr", "HRMS", "New announcement", {
    defaultChannels: IA_EMAIL,
  }),
  e("hr.emergency.broadcast", "hr", "HRMS", "Emergency safety broadcast", {
    defaultPriority: "CRITICAL",
    defaultType: "WARNING",
    defaultChannels: IA_PUSH_EMAIL,
    allowedChannels: ALLOWED_URGENT,
    mandatory: true,
    userConfigurable: false,
    quietHoursBehavior: "always_bypass",
    dedupeWindowSeconds: 0,
  }),
  e("payroll.run.created", "payroll", "PAYROLL", "Payroll run created", {
    defaultChannels: IA,
  }),
  e(
    "payroll.run.approval_requested",
    "payroll",
    "WORKFLOW",
    "Payroll approval requested",
    { defaultPriority: "HIGH", defaultChannels: IA_EMAIL },
  ),
  e("payroll.run.approved", "payroll", "PAYROLL", "Payroll approved", {
    defaultType: "SUCCESS",
    defaultChannels: IA_EMAIL,
  }),
  e("payroll.payment.failed", "payroll", "PAYROLL", "Payroll payment failed", {
    defaultPriority: "CRITICAL",
    defaultType: "ERROR",
    defaultChannels: IA_EMAIL,
    allowedChannels: ALLOWED_URGENT,
    mandatory: true,
    userConfigurable: false,
    quietHoursBehavior: "always_bypass",
  }),
  e("payroll.payslip.ready", "payroll", "PAYROLL", "Payslip ready", {
    defaultChannels: IA_EMAIL,
  }),
  e("payroll.tax.document.ready", "payroll", "PAYROLL", "Tax document ready", {
    defaultChannels: IA_EMAIL,
  }),
  e(
    "recruitment.candidate.applied",
    "recruitment",
    "RECRUITMENT",
    "New application",
    { defaultChannels: IA },
  ),
  e(
    "recruitment.candidate.referred",
    "recruitment",
    "RECRUITMENT",
    "Candidate referred",
    { defaultChannels: IA },
  ),
  e(
    "recruitment.interview.scheduled",
    "recruitment",
    "RECRUITMENT",
    "Interview scheduled",
    { defaultPriority: "HIGH", defaultChannels: IA_PUSH_EMAIL },
  ),
  e(
    "recruitment.interview.feedback_due",
    "recruitment",
    "RECRUITMENT",
    "Interview feedback due",
    { defaultChannels: IA_EMAIL },
  ),
  e(
    "recruitment.offer.approval_requested",
    "recruitment",
    "WORKFLOW",
    "Offer approval requested",
    { defaultPriority: "HIGH", defaultChannels: IA_EMAIL },
  ),
  e(
    "recruitment.offer.accepted",
    "recruitment",
    "RECRUITMENT",
    "Offer accepted",
    { defaultType: "SUCCESS", defaultChannels: IA_EMAIL },
  ),
];
