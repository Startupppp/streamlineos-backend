import type {
  NotificationChannel,
  NotificationEventDefinition,
} from "./notification-event-definition.types";
import {
  BUILD_TICKET_RESOURCE,
  DEFAULT_ALLOWED_CHANNELS,
  IN_APP,
  IN_APP_EMAIL,
  IN_APP_PUSH,
  IN_APP_PUSH_EMAIL,
  KNOWLEDGE_PAGE_RESOURCE,
  URGENT_ALLOWED_CHANNELS,
} from "./notification-event-channel-policy";
import { notificationEvent } from "./notification-event-factory";
import { CHAT_NOTIFICATION_EVENTS } from "./notification-events-chat.catalog";
import { BUILD_NOTIFICATION_EVENTS } from "./notification-events-build.catalog";

const IA = IN_APP;
const IA_EMAIL = IN_APP_EMAIL;
const IA_PUSH = IN_APP_PUSH;
const IA_PUSH_EMAIL = IN_APP_PUSH_EMAIL;
const KB_PAGE = KNOWLEDGE_PAGE_RESOURCE;
const BUILD_TICKET = BUILD_TICKET_RESOURCE;
const ALLOWED_DEFAULT = DEFAULT_ALLOWED_CHANNELS;
const ALLOWED_URGENT = URGENT_ALLOWED_CHANNELS;

/**
 * PIPE-003 resource kinds. An event carrying one is delivered only to recipients
 * who can still see the record, re-checked per recipient immediately before render.
 * The owning module registers the resolver; a declared kind with no resolver denies.
 */

// REG-005: generic on the key so every entry keeps its literal type, which is what
// makes NotificationEventKey below a real union instead of `string`.
const e = notificationEvent;
const CHAT = CHAT_NOTIFICATION_EVENTS;

const PROJECTS = BUILD_NOTIFICATION_EVENTS;

const CRM = [
  e("crm.lead.assigned", "crm", "CRM", "Lead assigned to you", {
    defaultPriority: "HIGH",
    defaultChannels: IA_EMAIL,
      rateLimitWindowSeconds: 3600,
    rateLimitMax: 50,
  }),
  e("crm.lead.created", "crm", "CRM", "New lead created", {
    defaultChannels: IA,
      rateLimitWindowSeconds: 3600,
    rateLimitMax: 100,
  }),
  e("crm.deal.stage_changed", "crm", "CRM", "Deal stage changed", {
    defaultChannels: IA,
  }),
  e("crm.followup.due", "crm", "CRM", "Follow-up due", {
    defaultChannels: IA_EMAIL,
    ttlSeconds: 86400,
      rateLimitWindowSeconds: 86400,
    rateLimitMax: 50,
  }),
  e("crm.followup.overdue", "crm", "CRM", "Follow-up overdue", {
    defaultPriority: "HIGH",
    defaultType: "WARNING",
    defaultChannels: IA_EMAIL,
  }),
  e(
    "crm.customer.message_received",
    "crm",
    "CRM",
    "Customer message received",
    { defaultPriority: "HIGH", defaultChannels: IA_PUSH },
  ),
  e("crm.automation.failed", "crm", "CRM", "Automation failed", {
    defaultPriority: "HIGH",
    defaultType: "ERROR",
    defaultChannels: IA_EMAIL,
  }),
  e("crm.lead.converted", "crm", "CRM", "Lead converted to client", {
    defaultType: "SUCCESS",
    defaultChannels: IA_PUSH,
  }),
  e("crm.client.assigned", "crm", "CRM", "New client assigned to you", {
    defaultPriority: "HIGH",
    defaultChannels: IA_PUSH,
  }),
  e("crm.ai.score_ready", "crm", "AI", "AI lead score generated", {
    defaultChannels: IA,
  }),
];

const HR = [
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
];

const PAYROLL = [
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
];

const RECRUITMENT = [
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

const KNOWLEDGE = [
  e(
    "knowledge.article.mentioned",
    "knowledge",
    "KNOWLEDGE",
    "Mentioned in an article",
    {
      defaultPriority: "HIGH",
      defaultChannels: IA_EMAIL,
      dedupeWindowSeconds: 0,
    },
  ),
  e(
    "knowledge.article.comment_created",
    "knowledge",
    "KNOWLEDGE",
    "New article comment",
    { defaultChannels: IA },
  ),
  e(
    "knowledge.article.approval_requested",
    "knowledge",
    "WORKFLOW",
    "Article approval requested",
    { defaultPriority: "HIGH", defaultChannels: IA_EMAIL },
  ),
  e(
    "knowledge.article.published",
    "knowledge",
    "KNOWLEDGE",
    "Article published",
    { defaultPriority: "LOW", defaultChannels: IA },
  ),
  e("knowledge.ai.answer_ready", "knowledge", "AI", "AI answer ready", {
    defaultChannels: IA,
  }),
  e(
    "knowledge.document.ingestion_failed",
    "knowledge",
    "KNOWLEDGE",
    "Document ingestion failed",
    {
      defaultPriority: "HIGH",
      defaultType: "ERROR",
      defaultChannels: IA_EMAIL,
    },
  ),
  e(
    "knowledge.page.comment_created",
    "knowledge",
    "KNOWLEDGE",
    "New comment on your page",
    { defaultChannels: IA, visibilityResourceKind: KB_PAGE },
  ),
  e(
    "knowledge.page.review_requested",
    "knowledge",
    "WORKFLOW",
    "Page review requested",
    {
      defaultPriority: "HIGH",
      defaultChannels: IA_EMAIL,
      visibilityResourceKind: KB_PAGE,
    },
  ),
  e(
    "knowledge.page.review_approved",
    "knowledge",
    "KNOWLEDGE",
    "Page review approved",
    {
      defaultType: "SUCCESS",
      defaultChannels: IA,
      visibilityResourceKind: KB_PAGE,
    },
  ),
  e(
    "knowledge.page.review_rejected",
    "knowledge",
    "KNOWLEDGE",
    "Page review rejected",
    {
      defaultType: "WARNING",
      defaultChannels: IA,
      visibilityResourceKind: KB_PAGE,
    },
  ),
];

const SIGN = [
  e("sign.document.sent", "sign", "SIGN", "Document sent for signature", {
    defaultChannels: IA_EMAIL,
  }),
  e("sign.document.viewed", "sign", "SIGN", "Document viewed", {
    defaultPriority: "LOW",
    defaultChannels: IA,
  }),
  e("sign.document.signed", "sign", "SIGN", "Document signed", {
    defaultType: "SUCCESS",
    defaultChannels: IA_EMAIL,
  }),
  e("sign.document.completed", "sign", "SIGN", "Document completed", {
    defaultPriority: "HIGH",
    defaultType: "SUCCESS",
    defaultChannels: IA_EMAIL,
    mandatory: true,
    userConfigurable: false,
    quietHoursBehavior: "bypass_if_high",
  }),
  e("sign.document.expiring", "sign", "SIGN", "Document expiring", {
    defaultPriority: "HIGH",
    defaultChannels: IA_EMAIL,
  }),
  e("sign.document.declined", "sign", "SIGN", "Document declined", {
    defaultPriority: "HIGH",
    defaultType: "WARNING",
    defaultChannels: IA_EMAIL,
  }),
];

const INVENTORY = [
  e("inventory.stock.low", "inventory", "INVENTORY", "Low stock", {
    defaultPriority: "HIGH",
    defaultChannels: IA_EMAIL,
  }),
  e("inventory.stock.out", "inventory", "INVENTORY", "Out of stock", {
    defaultPriority: "HIGH",
    defaultType: "WARNING",
    defaultChannels: IA_EMAIL,
  }),
  e(
    "inventory.reorder.suggested",
    "inventory",
    "INVENTORY",
    "Reorder suggested",
    { defaultChannels: IA },
  ),
  e(
    "inventory.transfer.requested",
    "inventory",
    "INVENTORY",
    "Transfer requested",
    { defaultChannels: IA },
  ),
  e(
    "inventory.transfer.completed",
    "inventory",
    "INVENTORY",
    "Transfer completed",
    { defaultType: "SUCCESS", defaultChannels: IA },
  ),
  e(
    "inventory.adjustment.approval_requested",
    "inventory",
    "WORKFLOW",
    "Adjustment approval requested",
    { defaultPriority: "HIGH", defaultChannels: IA_EMAIL },
  ),
  /**
   * E7. Raised when an outbound webhook has failed every attempt across the whole
   * retry window, while it is still enabled — the warning that precedes this
   * module disabling a customer's integration for them.
   *
   * Email as well as in-app, because the audience for "your integration stopped
   * working" is not reliably looking at the product when it happens, and the
   * whole point of the alert is that it lands before the disable does.
   */
  e("inventory.webhook.failing", "inventory", "INVENTORY", "Webhook delivery failing", {
    defaultPriority: "HIGH",
    defaultType: "WARNING",
    defaultChannels: IA_EMAIL,
  }),
  /**
   * G3. A lot that has entered a near-expiry window and still holds stock.
   *
   * In-app only, and not urgent: a lot ninety days out is a planning signal, and
   * emailing about it is how a category gets muted before the thirty-day one
   * arrives. The narrowing windows do the escalating, not the channel.
   */
  e("inventory.lot.expiring", "inventory", "INVENTORY", "Lot nearing expiry", {
    defaultType: "WARNING",
    defaultChannels: IA,
  }),
  /**
   * G3. A recall has been opened, and stock has stopped moving.
   *
   * The one inventory event that is urgent by its nature: the goods are already
   * quarantined and the lots already refused by the allocator, so this is the
   * message that tells a warehouse why. Email as well as in-app for the same
   * reason `inventory.webhook.failing` carries it — the audience is not reliably
   * looking at the product when it happens.
   */
  e("inventory.recall.opened", "inventory", "INVENTORY", "Recall opened", {
    defaultPriority: "HIGH",
    defaultType: "WARNING",
    defaultChannels: IA_EMAIL,
    allowedChannels: ALLOWED_URGENT,
  }),
];

const SURVEYS = [
  e(
    "survey.response.received",
    "surveys",
    "SURVEYS",
    "Survey response received",
    { defaultPriority: "LOW", defaultChannels: IA },
  ),
  e("survey.deadline.due_soon", "surveys", "SURVEYS", "Survey deadline soon", {
    defaultChannels: IA_EMAIL,
  }),
  e(
    "survey.certification.passed",
    "surveys",
    "SURVEYS",
    "Certification passed",
    { defaultType: "SUCCESS", defaultChannels: IA },
  ),
  e(
    "survey.certification.failed",
    "surveys",
    "SURVEYS",
    "Certification failed",
    { defaultType: "WARNING", defaultChannels: IA },
  ),
  e(
    "survey.live_session.started",
    "surveys",
    "SURVEYS",
    "Live session started",
    {
      defaultPriority: "HIGH",
      defaultChannels: IA_PUSH,
      quietHoursBehavior: "bypass_if_high",
      dedupeWindowSeconds: 0,
    },
  ),
];

const CALENDAR = [
  e("calendar.event.invited", "calendar", "CALENDAR", "Event invitation", {
    defaultChannels: IA_EMAIL,
  }),
  e(
    "calendar.event.starting_soon",
    "calendar",
    "CALENDAR",
    "Event starting soon",
    {
      defaultPriority: "HIGH",
      defaultChannels: IA_PUSH,
      quietHoursBehavior: "bypass_if_high",
      dedupeWindowSeconds: 0,
    },
  ),
  e("calendar.event.changed", "calendar", "CALENDAR", "Event updated", {
    defaultChannels: IA_EMAIL,
  }),
  e("calendar.event.cancelled", "calendar", "CALENDAR", "Event cancelled", {
    defaultPriority: "HIGH",
    defaultType: "WARNING",
    defaultChannels: IA_EMAIL,
  }),
  e("calendar.reminder", "calendar", "CALENDAR", "Reminder", {
    defaultChannels: IA_PUSH,
  }),
];

const BILLING = [
  e("billing.trial.expiring", "billing", "BILLING", "Trial ending soon", {
    defaultPriority: "HIGH",
    defaultChannels: IA_EMAIL,
  }),
  e("billing.invoice.created", "billing", "BILLING", "Invoice created", {
    defaultChannels: IA_EMAIL,
  }),
  e("billing.invoice.due_soon", "billing", "BILLING", "Invoice due soon", {
    defaultPriority: "HIGH",
    defaultChannels: IA_EMAIL,
  }),
  e("billing.payment.failed", "billing", "BILLING", "Payment failed", {
    defaultPriority: "CRITICAL",
    defaultType: "ERROR",
    defaultChannels: IA_EMAIL,
    allowedChannels: ALLOWED_URGENT,
    mandatory: true,
    userConfigurable: false,
    quietHoursBehavior: "always_bypass",
  }),
  e(
    "billing.subscription.changed",
    "billing",
    "BILLING",
    "Subscription changed",
    { defaultChannels: IA_EMAIL },
  ),
  e(
    "billing.subscription.cancelled",
    "billing",
    "BILLING",
    "Subscription cancelled",
    {
      defaultPriority: "HIGH",
      defaultType: "WARNING",
      defaultChannels: IA_EMAIL,
    },
  ),
];

const SECURITY = [
  e("security.login.new_device", "security", "SECURITY", "New device sign-in", {
    defaultPriority: "HIGH",
    defaultType: "WARNING",
    defaultChannels: IA_EMAIL,
    allowedChannels: ALLOWED_URGENT,
    mandatory: true,
    userConfigurable: false,
    quietHoursBehavior: "always_bypass",
  }),
  e("security.mfa.disabled", "security", "SECURITY", "Two-factor disabled", {
    defaultPriority: "CRITICAL",
    defaultType: "WARNING",
    defaultChannels: IA_EMAIL,
    allowedChannels: ALLOWED_URGENT,
    mandatory: true,
    userConfigurable: false,
    quietHoursBehavior: "always_bypass",
  }),
  e(
    "security.role.changed",
    "security",
    "SECURITY",
    "Role or permissions changed",
    {
      defaultPriority: "HIGH",
      defaultChannels: IA_EMAIL,
      allowedChannels: ALLOWED_URGENT,
      mandatory: true,
      userConfigurable: false,
      quietHoursBehavior: "always_bypass",
    },
  ),
  e("security.api_key.created", "security", "SECURITY", "API key created", {
    defaultPriority: "HIGH",
    defaultChannels: IA_EMAIL,
    allowedChannels: ALLOWED_URGENT,
    mandatory: true,
    userConfigurable: false,
    quietHoursBehavior: "always_bypass",
  }),
  e(
    "security.suspicious_activity",
    "security",
    "SECURITY",
    "Suspicious activity detected",
    {
      defaultPriority: "CRITICAL",
      defaultType: "ERROR",
      defaultChannels: IA_EMAIL,
      allowedChannels: ALLOWED_URGENT,
      mandatory: true,
      userConfigurable: false,
      quietHoursBehavior: "always_bypass",
    },
  ),
];

const SUPPORT = [
  e("support.ticket.assigned", "support", "SUPPORT", "Ticket assigned to you", {
    defaultPriority: "HIGH",
    defaultChannels: IA_EMAIL,
  }),
  e("support.ticket.updated", "support", "SUPPORT", "Support ticket updated", {
    defaultChannels: IA_EMAIL,
  }),
  e(
    "support.ticket.customer_replied",
    "support",
    "SUPPORT",
    "Customer replied",
    { defaultPriority: "HIGH", defaultChannels: IA_PUSH },
  ),
  e("support.ticket.sla_breached", "support", "SUPPORT", "SLA breached", {
    defaultPriority: "CRITICAL",
    defaultType: "ERROR",
    defaultChannels: IA_EMAIL,
    quietHoursBehavior: "bypass_if_high",
  }),
  e("support.ticket.escalated", "support", "SUPPORT", "Ticket escalated", {
    defaultPriority: "HIGH",
    defaultType: "WARNING",
    defaultChannels: IA_EMAIL,
  }),
  e(
    "support.ticket.mention",
    "support",
    "SUPPORT",
    "Mentioned in an internal note",
    {
      defaultPriority: "HIGH",
      defaultChannels: IA_PUSH,
      dedupeWindowSeconds: 0,
    },
  ),
  e(
    "support.kb.gap.routed",
    "support",
    "SUPPORT",
    "KB gap article needs review",
    {
      defaultPriority: "HIGH",
      defaultChannels: IA_EMAIL,
      description:
        "A draft KB article generated from a recurring support question needs human review before publishing",
    },
  ),
];

/**
 * C21-02. Fan-out-on-read: IN_APP is not in defaultChannels or allowedChannels,
 * so the dispatch pipeline never writes per-user notification rows for this event.
 * IN_APP delivery is served by the /broadcasts/inbox endpoint (absence-of-receipt
 * pattern). Non-IN_APP channels go through the pipeline so preferences, quiet
 * hours and email all apply.
 */
const BROADCAST_EMAIL: NotificationChannel[] = ["EMAIL"];
const BROADCAST_ALLOWED: NotificationChannel[] = ["EMAIL", "PUSH", "SMS", "WHATSAPP"];

const BROADCASTS = [
  e("notification.broadcast.published", "notification", "SYSTEM", "Organization announcement", {
    description: "An organization-wide broadcast was published to your audience group",
    defaultPriority: "NORMAL",
    defaultType: "INFO",
    defaultChannels: BROADCAST_EMAIL,
    allowedChannels: BROADCAST_ALLOWED,
    mandatory: false,
    userConfigurable: true,
    quietHoursBehavior: "respect",
    dedupeWindowSeconds: 0,
  }),
];

const SYSTEM = [
  e("system.weekly_recap", "system", "SYSTEM", "Weekly executive recap", {
    defaultChannels: IA_EMAIL,
    dedupeWindowSeconds: 86400,
  }),
  e("tasks.task.assigned", "tasks", "SYSTEM", "Task assigned to you", {
    defaultPriority: "HIGH",
    defaultChannels: IA_EMAIL,
  }),
  e(
    "compliance.policy.updated",
    "system",
    "SYSTEM",
    "Compliance policy updated",
    {
      defaultPriority: "HIGH",
      defaultChannels: IA_EMAIL,
      allowedChannels: ALLOWED_URGENT,
      mandatory: true,
      userConfigurable: false,
      quietHoursBehavior: "always_bypass",
    },
  ),
];

const OWNERSHIP = [
  e(
    "ownership.transfer.requested",
    "ownership",
    "SECURITY",
    "Ownership transfer requested",
    {
      description:
        "You have been nominated to take over an organization or module ownership",
      defaultPriority: "HIGH",
      defaultChannels: IA_EMAIL,
      allowedChannels: ALLOWED_URGENT,
      mandatory: true,
      userConfigurable: false,
      quietHoursBehavior: "always_bypass",
      dedupeWindowSeconds: 0,
    },
  ),
  e(
    "ownership.transfer.accepted",
    "ownership",
    "SECURITY",
    "Ownership transfer accepted",
    {
      description:
        "An ownership transfer was accepted and control has changed hands",
      defaultPriority: "HIGH",
      defaultType: "SUCCESS",
      defaultChannels: IA_EMAIL,
      allowedChannels: ALLOWED_URGENT,
      mandatory: true,
      userConfigurable: false,
      quietHoursBehavior: "always_bypass",
      dedupeWindowSeconds: 0,
    },
  ),
  e(
    "ownership.transfer.declined",
    "ownership",
    "SECURITY",
    "Ownership transfer declined",
    {
      defaultPriority: "HIGH",
      defaultType: "WARNING",
      dedupeWindowSeconds: 0,
    },
  ),
  e(
    "ownership.transfer.cancelled",
    "ownership",
    "SECURITY",
    "Ownership transfer cancelled",
    {
      defaultType: "WARNING",
      dedupeWindowSeconds: 0,
    },
  ),
  e(
    "ownership.transfer.expired",
    "ownership",
    "SECURITY",
    "Ownership transfer expired",
    {
      defaultType: "WARNING",
      dedupeWindowSeconds: 0,
    },
  ),
  e(
    "ownership.module_owner.changed",
    "ownership",
    "SECURITY",
    "Module ownership changed",
    {
      description: "You gained or lost lifecycle ownership of a module",
      defaultPriority: "HIGH",
      defaultChannels: IA_EMAIL,
      allowedChannels: ALLOWED_URGENT,
      mandatory: true,
      userConfigurable: false,
      quietHoursBehavior: "always_bypass",
      dedupeWindowSeconds: 0,
    },
  ),
];

const ORGANIZATION = [
  e(
    "organization.setup.completed",
    "organization",
    "SYSTEM",
    "Organization setup completed",
    { defaultChannels: IA_EMAIL },
  ),
  e(
    "organization.invitation.accepted",
    "organization",
    "SECURITY",
    "Invitation accepted",
    {
      description: "Someone you invited accepted and joined the organization",
      defaultType: "SUCCESS",
    },
  ),
  e(
    "organization.invitation.declined",
    "organization",
    "SECURITY",
    "Invitation declined",
    {
      description: "Someone you invited declined the invitation",
      defaultType: "WARNING",
    },
  ),
  e(
    "organization.invitation.expired",
    "organization",
    "SECURITY",
    "Invitation expired",
    {
      description: "An invitation you sent expired before it was accepted",
      defaultType: "WARNING",
    },
  ),
  e(
    "organization.member.reactivated",
    "organization",
    "SECURITY",
    "Your access was restored",
    {
      description: "Your membership in an organization was reactivated",
      defaultPriority: "HIGH",
      defaultType: "SUCCESS",
      defaultChannels: IA_EMAIL,
      allowedChannels: ALLOWED_URGENT,
      mandatory: true,
      userConfigurable: false,
      quietHoursBehavior: "always_bypass",
      dedupeWindowSeconds: 0,
    },
  ),
  e(
    "organization.member.left",
    "organization",
    "SECURITY",
    "Member left the organization",
    {
      defaultType: "WARNING",
    },
  ),
];

const ACCOUNTING = [
  e(
    "accounting.invoice.overdue",
    "accounting",
    "ACCOUNTING",
    "Invoice overdue",
    {
      defaultPriority: "HIGH",
      defaultType: "WARNING",
      defaultChannels: IA_EMAIL,
    },
  ),
  e(
    "accounting.invoice.payment_received",
    "accounting",
    "ACCOUNTING",
    "Invoice payment received",
    { defaultType: "SUCCESS", defaultChannels: IA_EMAIL },
  ),
  e(
    "accounting.invoice.recurring_generated",
    "accounting",
    "ACCOUNTING",
    "Recurring invoice generated",
    { defaultChannels: IA },
  ),
  e("accounting.bill.due", "accounting", "ACCOUNTING", "Bill due soon", {
    defaultPriority: "HIGH",
    defaultChannels: IA_EMAIL,
  }),
  e(
    "accounting.bill.approval_requested",
    "accounting",
    "WORKFLOW",
    "Bill approval requested",
    { defaultPriority: "HIGH", defaultChannels: IA_EMAIL },
  ),
  e("accounting.bill.approved", "accounting", "ACCOUNTING", "Bill approved", {
    defaultType: "SUCCESS",
    defaultChannels: IA_EMAIL,
  }),
  e(
    "accounting.bill.recurring_generated",
    "accounting",
    "ACCOUNTING",
    "Recurring bill generated",
    { defaultChannels: IA },
  ),
  e(
    "accounting.payment.failed",
    "accounting",
    "ACCOUNTING",
    "Vendor payment failed",
    {
      defaultPriority: "CRITICAL",
      defaultType: "ERROR",
      defaultChannels: IA_EMAIL,
      allowedChannels: ALLOWED_URGENT,
      mandatory: true,
      userConfigurable: false,
      quietHoursBehavior: "always_bypass",
    },
  ),
  e(
    "accounting.payment.recorded",
    "accounting",
    "ACCOUNTING",
    "Vendor payment recorded",
    { defaultType: "SUCCESS", defaultChannels: IA },
  ),
  e(
    "accounting.expense.submitted",
    "accounting",
    "WORKFLOW",
    "Expense submitted for approval",
    { defaultPriority: "HIGH", defaultChannels: IA_EMAIL },
  ),
  e(
    "accounting.expense.approved",
    "accounting",
    "ACCOUNTING",
    "Expense approved",
    { defaultType: "SUCCESS", defaultChannels: IA_EMAIL },
  ),
  e(
    "accounting.expense.rejected",
    "accounting",
    "ACCOUNTING",
    "Expense rejected",
    { defaultType: "WARNING", defaultChannels: IA_EMAIL },
  ),
  e(
    "accounting.reimbursement.paid",
    "accounting",
    "ACCOUNTING",
    "Expense reimbursement paid",
    { defaultType: "SUCCESS", defaultChannels: IA_EMAIL },
  ),
  e(
    "accounting.approval.requested",
    "accounting",
    "WORKFLOW",
    "Finance approval requested",
    { defaultPriority: "HIGH", defaultChannels: IA_EMAIL },
  ),
  e(
    "accounting.approval.decided",
    "accounting",
    "ACCOUNTING",
    "Finance approval decided",
    { defaultChannels: IA_EMAIL },
  ),
  e(
    "accounting.period.closed",
    "accounting",
    "ACCOUNTING",
    "Accounting period closed",
    { defaultChannels: IA },
  ),
  e(
    "accounting.period.reopened",
    "accounting",
    "ACCOUNTING",
    "Accounting period reopened",
    {
      defaultPriority: "HIGH",
      defaultType: "WARNING",
      defaultChannels: IA_EMAIL,
    },
  ),
  e(
    "accounting.reconciliation.mismatch",
    "accounting",
    "ACCOUNTING",
    "Bank reconciliation mismatch",
    {
      defaultPriority: "HIGH",
      defaultType: "WARNING",
      defaultChannels: IA_EMAIL,
    },
  ),
  e(
    "accounting.bank.import_completed",
    "accounting",
    "ACCOUNTING",
    "Bank import completed",
    { defaultType: "SUCCESS", defaultChannels: IA },
  ),
  e("accounting.tax.due", "accounting", "ACCOUNTING", "Tax payment due", {
    defaultPriority: "HIGH",
    defaultChannels: IA_EMAIL,
  }),
  e(
    "accounting.tax.payment_posted",
    "accounting",
    "ACCOUNTING",
    "Tax payment posted",
    { defaultType: "SUCCESS", defaultChannels: IA },
  ),
  e(
    "accounting.budget.exceeded",
    "accounting",
    "ACCOUNTING",
    "Budget threshold exceeded",
    {
      defaultPriority: "HIGH",
      defaultType: "WARNING",
      defaultChannels: IA_EMAIL,
    },
  ),
  e(
    "accounting.depreciation.run_posted",
    "accounting",
    "ACCOUNTING",
    "Depreciation run posted",
    { defaultChannels: IA },
  ),
];

export const NOTIFICATION_EVENT_CATALOG = [
    ...CHAT,
    ...PROJECTS,
    ...CRM,
    ...HR,
    ...PAYROLL,
    ...RECRUITMENT,
    ...KNOWLEDGE,
    ...SIGN,
    ...INVENTORY,
    ...SURVEYS,
    ...CALENDAR,
    ...BILLING,
    ...SECURITY,
    ...SUPPORT,
    ...SYSTEM,
    ...ACCOUNTING,
    ...OWNERSHIP,
    ...ORGANIZATION,
    ...BROADCASTS,
  ];

/**
 * REG-005. The keys that actually exist, as a compile-time union. A typo, or a key
 * from another namespace (`build:ticket:assigned` against a catalog declaring
 * `build.ticket.assigned`), is now a build error rather than a notification that is
 * silently never delivered — which is exactly how REG-004 survived unnoticed.
 */
export type NotificationEventKey =
  (typeof NOTIFICATION_EVENT_CATALOG)[number]["eventKey"];

const EVENT_KEY_SET: ReadonlySet<string> = new Set(
  NOTIFICATION_EVENT_CATALOG.map((def) => def.eventKey),
);

/**
 * Boundary guard for keys arriving from a request. A type predicate, not a cast —
 * the admin emit endpoint accepts an arbitrary string and must reject anything the
 * catalog does not declare rather than queue an event nothing can route.
 */
export function isNotificationEventKey(
  value: string,
): value is NotificationEventKey {
  return EVENT_KEY_SET.has(value);
}

export const NOTIFICATION_EVENT_MAP: ReadonlyMap<
  string,
  NotificationEventDefinition
> = new Map(NOTIFICATION_EVENT_CATALOG.map((def) => [def.eventKey, def]));
