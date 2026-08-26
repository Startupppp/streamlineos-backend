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
    deliveryClass: DeliveryClass.PRODUCT_EVENT,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote: "mail lane owns email.service — classify only",
  },
  {
    file: "modules/build/core/projects-email.service.ts",
    deliveryClass: DeliveryClass.PRODUCT_EVENT,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote: "mail lane owns email.service — classify only",
  },
  {
    file: "modules/calendar/calendar.service.ts",
    deliveryClass: DeliveryClass.PRODUCT_EVENT,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote: "mail lane owns email.service — classify only",
  },
  {
    file: "modules/chat/chat-reply-reminders.service.ts",
    deliveryClass: DeliveryClass.PRODUCT_EVENT,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote: "mail lane owns email.service — classify only",
  },
  {
    file: "modules/clients/clients-email.service.ts",
    deliveryClass: DeliveryClass.WORKFLOW_EXTERNAL,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote: "mail lane owns email.service — classify only",
  },
  {
    file: "modules/cron/cron-billing.service.ts",
    deliveryClass: DeliveryClass.PRODUCT_EVENT,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote: "mail lane owns email.service — classify only",
  },
  {
    file: "modules/cron/cron-hr.service.ts",
    deliveryClass: DeliveryClass.PRODUCT_EVENT,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote: "mail lane owns email.service — classify only",
  },
  {
    file: "modules/cron/cron-recruitment.service.ts",
    deliveryClass: DeliveryClass.WORKFLOW_EXTERNAL,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote: "mail lane owns email.service — classify only",
  },
  {
    file: "modules/cron/cron-weekly-recap.service.ts",
    deliveryClass: DeliveryClass.PRODUCT_EVENT,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote: "mail lane owns email.service — classify only",
  },
  {
    file: "modules/deals/deals.service.ts",
    deliveryClass: DeliveryClass.PRODUCT_EVENT,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote: "mail lane owns email.service — classify only",
  },
  {
    file: "modules/e-sign/sign-notifications.service.ts",
    deliveryClass: DeliveryClass.WORKFLOW_EXTERNAL,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote: "mail lane owns email.service — classify only",
  },
  {
    file: "modules/expenses/expenses-write.service.ts",
    deliveryClass: DeliveryClass.PRODUCT_EVENT,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote: "mail lane owns email.service — classify only",
  },
  {
    file: "modules/hr/automations/hr-automation-actions.service.ts",
    deliveryClass: DeliveryClass.WORKFLOW_EXTERNAL,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote: "uses AutomationEmailService adapter; mail lane owns it — classify only",
  },
  {
    file: "modules/hr/config/hr-holidays.service.ts",
    deliveryClass: DeliveryClass.PRODUCT_EVENT,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote: "mail lane owns email.service — classify only",
  },
  {
    file: "modules/hr/directory/asset-inventory.service.ts",
    deliveryClass: DeliveryClass.PRODUCT_EVENT,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote: "mail lane owns email.service — classify only",
  },
  {
    file: "modules/hr/directory/employee-onboarding.service.ts",
    deliveryClass: DeliveryClass.PRODUCT_EVENT,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote: "mail lane owns email.service — classify only",
  },
  {
    file: "modules/hr/helpdesk/hr-helpdesk.service.ts",
    deliveryClass: DeliveryClass.PRODUCT_EVENT,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote: "mail lane owns email.service — classify only",
  },
  {
    file: "modules/hr/interviews/hr-interview-booking.service.ts",
    deliveryClass: DeliveryClass.WORKFLOW_EXTERNAL,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote: "mail lane owns email.service — classify only",
  },
  {
    file: "modules/hr/interviews/hr-interview-results.service.ts",
    deliveryClass: DeliveryClass.WORKFLOW_EXTERNAL,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote: "mail lane owns email.service — classify only",
  },
  {
    file: "modules/hr/interviews/hr-interview-scheduling.service.ts",
    deliveryClass: DeliveryClass.WORKFLOW_EXTERNAL,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote: "mail lane owns email.service — classify only",
  },
  {
    file: "modules/hr/lifecycle/exit-write.service.ts",
    deliveryClass: DeliveryClass.PRODUCT_EVENT,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote: "mail lane owns email.service — classify only",
  },
  {
    file: "modules/hr/lifecycle/termination-communications.service.ts",
    deliveryClass: DeliveryClass.PRODUCT_EVENT,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote: "mail lane owns email.service — classify only",
  },
  {
    file: "modules/hr/onboarding/core/onboarding-initiation-dispatch.service.ts",
    deliveryClass: DeliveryClass.PRODUCT_EVENT,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote: "mail lane owns email.service — classify only",
  },
  {
    file: "modules/hr/onboarding/core/onboarding-task.service.ts",
    deliveryClass: DeliveryClass.PRODUCT_EVENT,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote: "mail lane owns email.service — classify only",
  },
  {
    file: "modules/hr/performance/performance-reviews.service.ts",
    deliveryClass: DeliveryClass.PRODUCT_EVENT,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote: "mail lane owns email.service — classify only",
  },
  {
    file: "modules/hr/recruitment/recruitment-automation.service.ts",
    deliveryClass: DeliveryClass.WORKFLOW_EXTERNAL,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote: "mail lane owns email.service — classify only",
  },
  {
    file: "modules/hr/recruitment/recruitment-candidate-docs.service.ts",
    deliveryClass: DeliveryClass.WORKFLOW_EXTERNAL,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote: "mail lane owns email.service — classify only",
  },
  {
    file: "modules/hr/recruitment/recruitment-candidate-ops.service.ts",
    deliveryClass: DeliveryClass.WORKFLOW_EXTERNAL,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote: "mail lane owns email.service — classify only",
  },
  {
    file: "modules/hr/recruitment/recruitment-candidates.service.ts",
    deliveryClass: DeliveryClass.WORKFLOW_EXTERNAL,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote: "mail lane owns email.service — classify only",
  },
  {
    file: "modules/hr/time/attendance.service.ts",
    deliveryClass: DeliveryClass.PRODUCT_EVENT,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote: "mail lane owns email.service — classify only",
  },
  {
    file: "modules/hr/time/leave-decision-effects.service.ts",
    deliveryClass: DeliveryClass.PRODUCT_EVENT,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote: "mail lane owns email.service — classify only",
  },
  {
    file: "modules/hr/time/leaves-write.service.ts",
    deliveryClass: DeliveryClass.PRODUCT_EVENT,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote: "mail lane owns email.service — classify only",
  },
  {
    file: "modules/hr/time/work-logs.service.ts",
    deliveryClass: DeliveryClass.PRODUCT_EVENT,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote: "mail lane owns email.service — classify only",
  },
  {
    file: "modules/leads/lead-conversion.service.ts",
    deliveryClass: DeliveryClass.PRODUCT_EVENT,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote: "mail lane owns email.service — classify only",
  },
  {
    file: "modules/leads/leads-detail.service.ts",
    deliveryClass: DeliveryClass.PRODUCT_EVENT,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote: "mail lane owns email.service — classify only",
  },
  {
    file: "modules/leads/leads-ops.service.ts",
    deliveryClass: DeliveryClass.PRODUCT_EVENT,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote: "mail lane owns email.service — classify only",
  },
  {
    file: "modules/leads/leads.service.ts",
    deliveryClass: DeliveryClass.PRODUCT_EVENT,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote: "mail lane owns email.service — classify only",
  },
  {
    file: "modules/organization/core/invitations.service.ts",
    deliveryClass: DeliveryClass.WORKFLOW_EXTERNAL,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote: "mail lane owns email.service — classify only; invitation goes to non-members",
  },
  {
    file: "modules/organization/core/org-membership.service.ts",
    deliveryClass: DeliveryClass.PRODUCT_EVENT,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote: "mail lane owns email.service — classify only",
  },
  {
    file: "modules/organization/setup/org-setup.service.ts",
    deliveryClass: DeliveryClass.PRODUCT_EVENT,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote: "mail lane owns email.service — classify only",
  },
  {
    file: "modules/payroll/payout/publishing.service.ts",
    deliveryClass: DeliveryClass.PRODUCT_EVENT,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote: "mail lane owns email.service — classify only",
  },
  {
    file: "modules/platform/platform.service.ts",
    deliveryClass: DeliveryClass.PRODUCT_EVENT,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote: "mail lane owns email.service — classify only",
  },
  {
    file: "modules/public/contact.service.ts",
    deliveryClass: DeliveryClass.OPERATOR_ALERT,
    migrationStatus: MigrationStatus.EXEMPT,
    blockerNote: "unauthenticated path; no org context; alerts platform admin of contact form — exempt from dispatch pipeline",
  },
  {
    file: "modules/public/waitlist.service.ts",
    deliveryClass: DeliveryClass.OPERATOR_ALERT,
    migrationStatus: MigrationStatus.EXEMPT,
    blockerNote: "unauthenticated path; no org context; alerts platform admin of waitlist signup — exempt from dispatch pipeline",
  },
  {
    file: "modules/support/core/support-notifications.service.ts",
    deliveryClass: DeliveryClass.PRODUCT_EVENT,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote: "mail lane owns email.service — classify only",
  },
  {
    file: "modules/tasks/task-notifications.service.ts",
    deliveryClass: DeliveryClass.PRODUCT_EVENT,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote: "mail lane owns email.service — classify only",
  },
  {
    file: "modules/users/user-ops.service.ts",
    deliveryClass: DeliveryClass.PRODUCT_EVENT,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote: "mail lane owns email.service — classify only",
  },
  {
    file: "modules/automation/automation.service.ts",
    deliveryClass: DeliveryClass.WORKFLOW_EXTERNAL,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote: "uses AutomationEmailService adapter; mail lane owns it — classify only",
  },
  {
    file: "modules/automation/automation-email.service.ts",
    deliveryClass: DeliveryClass.WORKFLOW_EXTERNAL,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote: "is the automation email adapter; sends to automation-supplied recipients",
  },
  {
    file: "modules/build/core/projects-provision.service.ts",
    deliveryClass: DeliveryClass.PRODUCT_EVENT,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote: "uses ProjectsEmailService adapter; classify only",
  },
  {
    file: "modules/build/core/projects-tickets-transfer.service.ts",
    deliveryClass: DeliveryClass.PRODUCT_EVENT,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote: "uses ProjectsEmailService adapter; classify only",
  },
  {
    file: "modules/build/core/projects-tickets-update.service.ts",
    deliveryClass: DeliveryClass.PRODUCT_EVENT,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote: "uses ProjectsEmailService adapter; classify only",
  },
  {
    file: "modules/clients/client-accounts.service.ts",
    deliveryClass: DeliveryClass.WORKFLOW_EXTERNAL,
    migrationStatus: MigrationStatus.PENDING_MIGRATION,
    blockerNote: "uses ClientsEmailService adapter; recipients are external clients",
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
