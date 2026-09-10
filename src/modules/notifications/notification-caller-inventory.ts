import { DeliveryClass } from "./notification-delivery-class";

export const MigrationStatus = {
  PENDING_MIGRATION: "PENDING_MIGRATION",
  EXEMPT: "EXEMPT",
} as const;

export type MigrationStatus =
  (typeof MigrationStatus)[keyof typeof MigrationStatus];

export type DirectEmailCallerInventoryEntry = {
  file: string;
  deliveryClass: DeliveryClass;
  migrationStatus: MigrationStatus;
  blockerNote: string;
};

const EXEMPT = (
  file: string,
  deliveryClass: DeliveryClass,
  blockerNote: string,
): DirectEmailCallerInventoryEntry => ({
  file,
  deliveryClass,
  migrationStatus: MigrationStatus.EXEMPT,
  blockerNote,
});

export const DIRECT_EMAIL_CALLER_INVENTORY: DirectEmailCallerInventoryEntry[] =
  [
    EXEMPT(
      "modules/auth/auth-email-verification.service.ts",
      DeliveryClass.OPERATOR_ALERT,
      "credential and account-recovery mail has no tenant-member notification recipient",
    ),
    EXEMPT(
      "modules/auth/auth-magic-link.service.ts",
      DeliveryClass.OPERATOR_ALERT,
      "credential and account-recovery mail has no tenant-member notification recipient",
    ),
    EXEMPT(
      "modules/auth/auth-email-otp.service.ts",
      DeliveryClass.OPERATOR_ALERT,
      "credential and account-recovery mail has no tenant-member notification recipient",
    ),
    EXEMPT(
      "modules/automation/automation-action-executor.service.ts",
      DeliveryClass.WORKFLOW_EXTERNAL,
      "automation-supplied recipient and workflow-owned provider semantics",
    ),
    EXEMPT(
      "modules/automation/automation-email.service.ts",
      DeliveryClass.WORKFLOW_EXTERNAL,
      "automation email adapter for automation-supplied recipients",
    ),
    EXEMPT(
      "modules/clients/client-accounts.service.ts",
      DeliveryClass.WORKFLOW_EXTERNAL,
      "external client workflow; recipients are not org members",
    ),
    EXEMPT(
      "modules/clients/clients-email.service.ts",
      DeliveryClass.WORKFLOW_EXTERNAL,
      "external client workflow adapter",
    ),
    EXEMPT(
      "modules/crm/automation-studio/crm-automation-runner.service.ts",
      DeliveryClass.MARKETING,
      "sends through the consent-enforcing CRM outbound seam",
    ),
    EXEMPT(
      "modules/crm/automation-studio/crm-sequences-runner.service.ts",
      DeliveryClass.MARKETING,
      "sends through the consent-enforcing CRM outbound seam",
    ),
    EXEMPT(
      "modules/crm/consent/crm-outbound-email.service.ts",
      DeliveryClass.MARKETING,
      "the consent seam itself; suppressed recipients are dropped before send",
    ),
    EXEMPT(
      "modules/cron/cron-recruitment.service.ts",
      DeliveryClass.WORKFLOW_EXTERNAL,
      "recruitment workflow mail targets candidates and external recipients",
    ),
    EXEMPT(
      "modules/e-sign/sign-notifications.service.ts",
      DeliveryClass.WORKFLOW_EXTERNAL,
      "signature workflow mail targets external signers",
    ),
    EXEMPT(
      "modules/hr/automations/hr-automation-actions.service.ts",
      DeliveryClass.WORKFLOW_EXTERNAL,
      "uses the automation email adapter for workflow-supplied recipients",
    ),
    EXEMPT(
      "modules/hr/directory/employee-bulk-onboarding.service.ts",
      DeliveryClass.WORKFLOW_EXTERNAL,
      "bulk form of the credential-bearing welcome workflow; same recipients and semantics",
    ),
    EXEMPT(
      "modules/hr/directory/employee-onboarding.service.ts",
      DeliveryClass.WORKFLOW_EXTERNAL,
      "credential-bearing welcome and magic-link workflow",
    ),
    EXEMPT(
      "modules/hr/time/attendance-email-report.service.ts",
      DeliveryClass.OPERATOR_ALERT,
      "authorized attendance report delivery to active organization members",
    ),
    EXEMPT(
      "modules/hr/interviews/hr-interview-booking.service.ts",
      DeliveryClass.WORKFLOW_EXTERNAL,
      "candidate/interviewer scheduling workflow with external recipients",
    ),
    EXEMPT(
      "modules/hr/interviews/hr-interview-results.service.ts",
      DeliveryClass.WORKFLOW_EXTERNAL,
      "candidate workflow results with external recipients",
    ),
    EXEMPT(
      "modules/hr/interviews/hr-interview-scheduling.service.ts",
      DeliveryClass.WORKFLOW_EXTERNAL,
      "candidate/interviewer scheduling workflow with external recipients",
    ),
    EXEMPT(
      "modules/hr/lifecycle/termination-communications.service.ts",
      DeliveryClass.WORKFLOW_EXTERNAL,
      "custom termination letter workflow with document semantics",
    ),
    EXEMPT(
      "modules/hr/recruitment/recruitment-automation.service.ts",
      DeliveryClass.WORKFLOW_EXTERNAL,
      "recruitment automation targets external candidates",
    ),
    EXEMPT(
      "modules/hr/recruitment/recruitment-candidate-docs.service.ts",
      DeliveryClass.WORKFLOW_EXTERNAL,
      "candidate document workflow targets external recipients",
    ),
    EXEMPT(
      "modules/hr/recruitment/recruitment-candidate-ops.service.ts",
      DeliveryClass.WORKFLOW_EXTERNAL,
      "candidate operations workflow targets external recipients",
    ),
    EXEMPT(
      "modules/hr/recruitment/recruitment-candidates.service.ts",
      DeliveryClass.WORKFLOW_EXTERNAL,
      "candidate workflow targets external recipients",
    ),
    EXEMPT(
      "modules/hr/time/attendance.service.ts",
      DeliveryClass.USER_AUTHORED,
      "attendance report supports arbitrary recipients and attachments",
    ),
    EXEMPT(
      "modules/organization/core/invitation-create.service.ts",
      DeliveryClass.WORKFLOW_EXTERNAL,
      "invitation goes to a non-member external recipient",
    ),
    EXEMPT(
      "modules/organization/core/invitation-lifecycle.service.ts",
      DeliveryClass.WORKFLOW_EXTERNAL,
      "resend and cancel notices go to a non-member external recipient",
    ),
    EXEMPT(
      "modules/organization/core/org-membership.service.ts",
      DeliveryClass.OPERATOR_ALERT,
      "retains backward-compatible delegators for external callers; access-loss notice targets suspended or removed members",
    ),
    EXEMPT(
      "modules/organization/core/org-member-departure.service.ts",
      DeliveryClass.OPERATOR_ALERT,
      "access-loss notice targets removed members; dispatch filters inactive recipients",
    ),
    EXEMPT(
      "modules/organization/core/org-membership-status.service.ts",
      DeliveryClass.OPERATOR_ALERT,
      "access-loss notice targets suspended members; dispatch filters inactive recipients",
    ),
    EXEMPT(
      "modules/organization/core/org-membership-access-revocation.ts",
      DeliveryClass.OPERATOR_ALERT,
      "membership-removed and membership-suspended notices target the affected member; no org-member notification recipient",
    ),
    EXEMPT(
      "modules/platform/platform-admin.service.ts",
      DeliveryClass.OPERATOR_ALERT,
      "platform admin contact-form reply has no tenant-member product recipient",
    ),
    EXEMPT(
      "modules/platform/platform.service.ts",
      DeliveryClass.OPERATOR_ALERT,
      "platform-level operator alert has no tenant-member product recipient",
    ),
    EXEMPT(
      "modules/public/contact.service.ts",
      DeliveryClass.OPERATOR_ALERT,
      "unauthenticated platform contact-form alert has no org context",
    ),
    EXEMPT(
      "modules/public/waitlist.service.ts",
      DeliveryClass.OPERATOR_ALERT,
      "unauthenticated platform waitlist alert has no org context",
    ),
    EXEMPT(
      "modules/users/user-ops.service.ts",
      DeliveryClass.OPERATOR_ALERT,
      "account recovery and security mail has no tenant-member notification recipient",
    ),
  ];

export function lookupCallerEntry(
  file: string,
): DirectEmailCallerInventoryEntry | undefined {
  return DIRECT_EMAIL_CALLER_INVENTORY.find((entry) => entry.file === file);
}
