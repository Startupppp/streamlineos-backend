import { DeliveryClass } from "./notification-delivery-class";

export const MigrationStatus = {
  PENDING_MIGRATION: "PENDING_MIGRATION",
  EXEMPT: "EXEMPT",
} as const;

export type MigrationStatus = (typeof MigrationStatus)[keyof typeof MigrationStatus];

export interface CallerInventoryEntry {
  readonly file: string;
  readonly deliveryClass: DeliveryClass;
  readonly migrationStatus: MigrationStatus;
  readonly blockerNote?: string;
}

export const DIRECT_EMAIL_CALLER_INVENTORY: readonly CallerInventoryEntry[] = [
  {
    file: "modules/auth/auth-tokens.service.ts",
    deliveryClass: DeliveryClass.OPERATOR_ALERT,
    migrationStatus: MigrationStatus.EXEMPT,
    blockerNote:
      "auth-level transactional email (verification, magic-link, OTP) sent before any org context exists; no orgId, no member preferences — exempt from the product-event dispatch pipeline",
  },
  {
    file: "modules/build/core/projects-email.service.ts",
    deliveryClass: DeliveryClass.PRODUCT_EVENT,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote:
      "IS the ProjectsEmailService domain adapter; its callers (projects-provision, projects-tickets-transfer, projects-tickets-update) use it directly — migrate the three callers to dispatch.emit() with build:* event keys, then delete this file",
  },
  {
    file: "modules/chat/chat-reply-reminders.service.ts",
    deliveryClass: DeliveryClass.PRODUCT_EVENT,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote:
      "aggregated per-user reminder; manually checks notificationPreferences.emailEnabled, muted, archived, has-replied before sending — migrate requires dispatch to support aggregated digest semantics or expose a per-user filter hook",
  },
  {
    file: "modules/clients/clients-email.service.ts",
    deliveryClass: DeliveryClass.WORKFLOW_EXTERNAL,
    migrationStatus: MigrationStatus.EXEMPT,
    blockerNote:
      "IS the ClientsEmailService domain adapter; recipients are external clients (not org members) — exempt: WORKFLOW_EXTERNAL mail to non-members cannot go through the preference-governed member dispatch pipeline",
  },
  {
    file: "modules/cron/cron-billing.service.ts",
    deliveryClass: DeliveryClass.PRODUCT_EVENT,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote:
      "uses sendTrialReminderEmail; already has orgId via forEachOrg but needs a billing.trial.expiring catalog event — add the event key then replace with dispatch.emit()",
  },
  {
    file: "modules/cron/cron-hr.service.ts",
    deliveryClass: DeliveryClass.PRODUCT_EVENT,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote:
      "HR digest/reminder cron; has orgId via forEachOrg but sends aggregated content across multiple employees — migrate requires dispatch to support aggregated cron digest semantics or per-employee emit loop",
  },
  {
    file: "modules/cron/cron-recruitment.service.ts",
    deliveryClass: DeliveryClass.WORKFLOW_EXTERNAL,
    migrationStatus: MigrationStatus.EXEMPT,
    blockerNote:
      "sends reminder emails to external candidates (not org members) — exempt: WORKFLOW_EXTERNAL mail to non-members cannot go through the preference-governed member dispatch pipeline",
  },
  {
    file: "modules/cron/cron-weekly-recap.service.ts",
    deliveryClass: DeliveryClass.PRODUCT_EVENT,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote:
      "sends aggregated weekly recap per user; content is multi-entity digest built per recipient — migrate requires dispatch to support digest channel or a per-user emit loop building variables from the recap aggregation",
  },
  {
    file: "modules/deals/deals.service.ts",
    deliveryClass: DeliveryClass.PRODUCT_EVENT,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote:
      "notifyStageChange has no orgId in scope; deal.orgId would need to be on DealRow or passed as a parameter — add orgId to DealRow projection, then replace with dispatch.emit(crm.deal.stage_changed)",
  },
  {
    file: "modules/e-sign/sign-notifications.service.ts",
    deliveryClass: DeliveryClass.WORKFLOW_EXTERNAL,
    migrationStatus: MigrationStatus.EXEMPT,
    blockerNote:
      "sends e-sign requests/reminders to external signatories (not necessarily org members) — exempt: WORKFLOW_EXTERNAL mail to non-members cannot go through the preference-governed member dispatch pipeline",
  },
  {
    file: "modules/expenses/expenses-write.service.ts",
    deliveryClass: DeliveryClass.PRODUCT_EVENT,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote:
      "notifies approver on expense submission; has orgId — replace with dispatch.emit(accounting.expense.submitted) once a catalog event is confirmed; review whether accounting.expense.* events cover all paths",
  },
  {
    file: "modules/hr/automations/hr-automation-actions.service.ts",
    deliveryClass: DeliveryClass.WORKFLOW_EXTERNAL,
    migrationStatus: MigrationStatus.EXEMPT,
    blockerNote:
      "uses AutomationEmailService adapter to send automation-triggered emails; recipients may be external — exempt: WORKFLOW_EXTERNAL mail to non-members cannot go through the preference-governed member dispatch pipeline",
  },
  {
    file: "modules/hr/config/hr-holidays.service.ts",
    deliveryClass: DeliveryClass.PRODUCT_EVENT,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote:
      "notifies employees of new/updated holidays; has orgId — needs a catalog event (hr.holiday.announced or similar) then dispatch.emit() with all active employee user IDs as targetUserIds",
  },
  {
    file: "modules/hr/directory/asset-inventory.service.ts",
    deliveryClass: DeliveryClass.PRODUCT_EVENT,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote:
      "notifies employee of asset assignment/return; has orgId and employee userId — needs catalog event (hr.asset.assigned or similar) then replace with dispatch.emit()",
  },
  {
    file: "modules/hr/directory/employee-onboarding.service.ts",
    deliveryClass: DeliveryClass.PRODUCT_EVENT,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote:
      "sends onboarding welcome/task emails; has orgId and new employee userId — needs catalog event (hr.onboarding.started or similar) then replace with dispatch.emit()",
  },
  {
    file: "modules/hr/helpdesk/hr-helpdesk.service.ts",
    deliveryClass: DeliveryClass.PRODUCT_EVENT,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote:
      "notifies assignee/requester on helpdesk ticket events; has orgId — needs catalog events (hr.helpdesk.ticket.assigned, hr.helpdesk.ticket.updated) then replace with dispatch.emit()",
  },
  {
    file: "modules/hr/interviews/hr-interview-booking.service.ts",
    deliveryClass: DeliveryClass.WORKFLOW_EXTERNAL,
    migrationStatus: MigrationStatus.EXEMPT,
    blockerNote:
      "sends interview booking confirmation to external candidates — exempt: WORKFLOW_EXTERNAL mail to non-members cannot go through the preference-governed member dispatch pipeline",
  },
  {
    file: "modules/hr/interviews/hr-interview-results.service.ts",
    deliveryClass: DeliveryClass.WORKFLOW_EXTERNAL,
    migrationStatus: MigrationStatus.EXEMPT,
    blockerNote:
      "sends interview result notification to external candidates — exempt: WORKFLOW_EXTERNAL mail to non-members cannot go through the preference-governed member dispatch pipeline",
  },
  {
    file: "modules/hr/interviews/hr-interview-scheduling.service.ts",
    deliveryClass: DeliveryClass.WORKFLOW_EXTERNAL,
    migrationStatus: MigrationStatus.EXEMPT,
    blockerNote:
      "sends interview scheduling emails to external candidates — exempt: WORKFLOW_EXTERNAL mail to non-members cannot go through the preference-governed member dispatch pipeline",
  },
  {
    file: "modules/hr/lifecycle/exit-write.service.ts",
    deliveryClass: DeliveryClass.PRODUCT_EVENT,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote:
      "notifies stakeholders on employee exit/offboarding events; has orgId — needs catalog events (hr.exit.initiated, hr.exit.completed) then replace with dispatch.emit()",
  },
  {
    file: "modules/hr/lifecycle/termination-communications.service.ts",
    deliveryClass: DeliveryClass.PRODUCT_EVENT,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote:
      "sends termination communications to HR/manager; has orgId — needs catalog event (hr.termination.processed) then replace with dispatch.emit()",
  },
  {
    file: "modules/hr/onboarding/core/onboarding-initiation-dispatch.service.ts",
    deliveryClass: DeliveryClass.PRODUCT_EVENT,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote:
      "sends onboarding initiation notification to new employee; has orgId and new employee userId — needs catalog event then replace with dispatch.emit()",
  },
  {
    file: "modules/hr/onboarding/core/onboarding-task.service.ts",
    deliveryClass: DeliveryClass.PRODUCT_EVENT,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote:
      "notifies assignee of new onboarding task; has orgId and assignee userId — needs catalog event (hr.onboarding.task.assigned) then replace with dispatch.emit()",
  },
  {
    file: "modules/hr/performance/performance-reviews.service.ts",
    deliveryClass: DeliveryClass.PRODUCT_EVENT,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote:
      "notifies reviewee/reviewer on performance review events; has orgId — needs catalog events (hr.review.cycle.started, hr.review.submitted) then replace with dispatch.emit()",
  },
  {
    file: "modules/hr/recruitment/recruitment-automation.service.ts",
    deliveryClass: DeliveryClass.WORKFLOW_EXTERNAL,
    migrationStatus: MigrationStatus.EXEMPT,
    blockerNote:
      "sends automated recruitment pipeline emails to external candidates — exempt: WORKFLOW_EXTERNAL mail to non-members cannot go through the preference-governed member dispatch pipeline",
  },
  {
    file: "modules/hr/recruitment/recruitment-candidate-docs.service.ts",
    deliveryClass: DeliveryClass.WORKFLOW_EXTERNAL,
    migrationStatus: MigrationStatus.EXEMPT,
    blockerNote:
      "sends document request emails to external candidates — exempt: WORKFLOW_EXTERNAL mail to non-members cannot go through the preference-governed member dispatch pipeline",
  },
  {
    file: "modules/hr/recruitment/recruitment-candidate-ops.service.ts",
    deliveryClass: DeliveryClass.WORKFLOW_EXTERNAL,
    migrationStatus: MigrationStatus.EXEMPT,
    blockerNote:
      "sends status update emails to external candidates — exempt: WORKFLOW_EXTERNAL mail to non-members cannot go through the preference-governed member dispatch pipeline",
  },
  {
    file: "modules/hr/recruitment/recruitment-candidates.service.ts",
    deliveryClass: DeliveryClass.WORKFLOW_EXTERNAL,
    migrationStatus: MigrationStatus.EXEMPT,
    blockerNote:
      "sends offer/rejection emails to external candidates — exempt: WORKFLOW_EXTERNAL mail to non-members cannot go through the preference-governed member dispatch pipeline",
  },
  {
    file: "modules/hr/time/attendance.service.ts",
    deliveryClass: DeliveryClass.PRODUCT_EVENT,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote:
      "notifies employee/manager of attendance events; has orgId — needs catalog events (hr.attendance.flagged or similar) then replace with dispatch.emit()",
  },
  {
    file: "modules/hr/time/leaves-write.service.ts",
    deliveryClass: DeliveryClass.PRODUCT_EVENT,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote:
      "notifies manager on leave request submission; has orgId — replace with dispatch.emit(hr.leave.requested) targeting the manager userId",
  },
  {
    file: "modules/hr/time/work-logs.service.ts",
    deliveryClass: DeliveryClass.PRODUCT_EVENT,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote:
      "notifies manager of work log submission; has orgId — needs catalog event (hr.worklogs.submitted or similar) then replace with dispatch.emit()",
  },
  {
    file: "modules/leads/lead-conversion.service.ts",
    deliveryClass: DeliveryClass.PRODUCT_EVENT,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote:
      "notifies assignee on lead conversion; has orgId — replace with dispatch.emit(crm.lead.converted) once lead.orgId is in scope at the call site",
  },
  {
    file: "modules/leads/leads-detail.service.ts",
    deliveryClass: DeliveryClass.PRODUCT_EVENT,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote:
      "sendAssignmentEmail has no orgId; would need orgId from LeadRow or parent scope — add orgId to LeadRow projection, then replace with dispatch.emit(crm.lead.assigned)",
  },
  {
    file: "modules/leads/leads-ops.service.ts",
    deliveryClass: DeliveryClass.PRODUCT_EVENT,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote:
      "notifies on lead ops events; review whether orgId is in scope — add if missing, then replace with dispatch.emit() using appropriate crm.lead.* event key",
  },
  {
    file: "modules/leads/leads.service.ts",
    deliveryClass: DeliveryClass.PRODUCT_EVENT,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote:
      "sendLeadAssignedNotification private method has no orgId; calling context (create) has orgId — thread orgId into the private method then replace with dispatch.emit(crm.lead.assigned)",
  },
  {
    file: "modules/organization/core/invitations.service.ts",
    deliveryClass: DeliveryClass.WORKFLOW_EXTERNAL,
    migrationStatus: MigrationStatus.EXEMPT,
    blockerNote:
      "sends invitation email to a non-member email address; recipient is not yet an org member — exempt: WORKFLOW_EXTERNAL mail to non-members cannot go through the preference-governed member dispatch pipeline",
  },
  {
    file: "modules/organization/core/org-membership.service.ts",
    deliveryClass: DeliveryClass.PRODUCT_EVENT,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote:
      "notifies member on membership events (invitation accepted/declined/expired, reactivation, member left); has orgId — replace with dispatch.emit() using organization.* event keys from the catalog",
  },
  {
    file: "modules/organization/setup/org-setup.service.ts",
    deliveryClass: DeliveryClass.PRODUCT_EVENT,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote:
      "sends org setup confirmation to owner; has orgId — needs catalog event (organization.setup.completed or similar) then replace with dispatch.emit()",
  },
  {
    file: "modules/payroll/payout/publishing.service.ts",
    deliveryClass: DeliveryClass.PRODUCT_EVENT,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote:
      "sends payslip email with PDF attachment; dispatch.emit() does not support binary attachments — blocker: extend dispatch with attachment support or keep this direct and gate on payroll.payslip.ready catalog event for in-app only",
  },
  {
    file: "modules/platform/platform.service.ts",
    deliveryClass: DeliveryClass.OPERATOR_ALERT,
    migrationStatus: MigrationStatus.EXEMPT,
    blockerNote:
      "contact form admin notification and auto-reply sent with no org context; platform-level operator alert — exempt from the product-event dispatch pipeline",
  },
  {
    file: "modules/public/contact.service.ts",
    deliveryClass: DeliveryClass.OPERATOR_ALERT,
    migrationStatus: MigrationStatus.EXEMPT,
    blockerNote:
      "unauthenticated path; no org context; alerts platform admin of contact form — exempt from dispatch pipeline",
  },
  {
    file: "modules/public/waitlist.service.ts",
    deliveryClass: DeliveryClass.OPERATOR_ALERT,
    migrationStatus: MigrationStatus.EXEMPT,
    blockerNote:
      "unauthenticated path; no org context; alerts platform admin of waitlist signup — exempt from dispatch pipeline",
  },
  {
    file: "modules/support/core/support-notifications.service.ts",
    deliveryClass: DeliveryClass.PRODUCT_EVENT,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote:
      "sendAssignmentEmail/sendStatusEmail/sendReplyEmail/sendEscalationEmail have no orgId in their interface; cascading change required to all callers — thread orgId into the interface, then replace with dispatch.emit() using support.* event keys",
  },
  {
    file: "modules/tasks/task-notifications.service.ts",
    deliveryClass: DeliveryClass.PRODUCT_EVENT,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote:
      "notifyAssignee interface has no orgId; cascading change required to all callers — thread orgId into the interface, then replace with dispatch.emit() using a tasks.task.assigned catalog event",
  },
  {
    file: "modules/users/user-ops.service.ts",
    deliveryClass: DeliveryClass.PRODUCT_EVENT,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote:
      "sends user account lifecycle emails (password reset, email change confirmation); events occur outside org context — classify as OPERATOR_ALERT and exempt, or add orgId if a member-scoped context is available",
  },
  {
    file: "modules/automation/automation.service.ts",
    deliveryClass: DeliveryClass.WORKFLOW_EXTERNAL,
    migrationStatus: MigrationStatus.EXEMPT,
    blockerNote:
      "uses AutomationEmailService adapter to dispatch workflow-triggered emails; recipients are automation-supplied and may be external — exempt: WORKFLOW_EXTERNAL mail to non-members cannot go through the preference-governed member dispatch pipeline",
  },
  {
    file: "modules/automation/automation-email.service.ts",
    deliveryClass: DeliveryClass.WORKFLOW_EXTERNAL,
    migrationStatus: MigrationStatus.EXEMPT,
    blockerNote:
      "IS the AutomationEmailService domain adapter; it IS the seam for automation-triggered external mail — exempt: this is the adapter itself, not a caller",
  },
  {
    file: "modules/build/core/projects-provision.service.ts",
    deliveryClass: DeliveryClass.PRODUCT_EVENT,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote:
      "uses ProjectsEmailService adapter; migrate by replacing ProjectsEmailService.notifyProjectMembers with dispatch.emit() using a build:* event key, then remove the adapter",
  },
  {
    file: "modules/build/core/projects-tickets-transfer.service.ts",
    deliveryClass: DeliveryClass.PRODUCT_EVENT,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote:
      "uses ProjectsEmailService adapter; migrate by replacing ProjectsEmailService.notifyTicketAssignees with dispatch.emit() using a build:* event key, then remove the adapter",
  },
  {
    file: "modules/build/core/projects-tickets-update.service.ts",
    deliveryClass: DeliveryClass.PRODUCT_EVENT,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote:
      "uses ProjectsEmailService adapter; migrate by replacing ProjectsEmailService.notifyStatusReview with dispatch.emit() using a build:* event key, then remove the adapter",
  },
  {
    file: "modules/clients/client-accounts.service.ts",
    deliveryClass: DeliveryClass.WORKFLOW_EXTERNAL,
    migrationStatus: MigrationStatus.EXEMPT,
    blockerNote:
      "uses ClientsEmailService adapter; recipients are external clients (not org members) — exempt: WORKFLOW_EXTERNAL mail to non-members cannot go through the preference-governed member dispatch pipeline",
  },
  {
    file: "modules/crm/consent/crm-outbound-email.service.ts",
    deliveryClass: DeliveryClass.MARKETING,
    migrationStatus: MigrationStatus.EXEMPT,
    blockerNote:
      "this IS the consent seam: drops every address CrmConsentService.suppressedEmails returns before sending, and a wholly-suppressed audience is a no-op rather than an error",
  },
  {
    file: "modules/crm/automation-studio/crm-sequences-runner.service.ts",
    deliveryClass: DeliveryClass.MARKETING,
    migrationStatus: MigrationStatus.EXEMPT,
    blockerNote: "sends only through CrmOutboundEmailService, so consent is already enforced",
  },
  {
    file: "modules/crm/automation-studio/crm-automation-runner.service.ts",
    deliveryClass: DeliveryClass.MARKETING,
    migrationStatus: MigrationStatus.EXEMPT,
    blockerNote: "sends only through CrmOutboundEmailService, so consent is already enforced",
  },
] as const;

export function lookupCallerEntry(file: string): CallerInventoryEntry | undefined {
  return DIRECT_EMAIL_CALLER_INVENTORY.find((e) => e.file === file);
}
