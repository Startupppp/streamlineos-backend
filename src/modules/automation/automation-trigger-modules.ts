import { AUTOMATION_TRIGGERS, type AutomationTriggerEvent } from "../../db/schema/automation/rules";

export const AUTOMATION_TRIGGER_MODULES = ["crm", "support", "finance", "hr", "sign"] as const;

export type AutomationTriggerModule = (typeof AUTOMATION_TRIGGER_MODULES)[number];

export const AUTOMATION_TRIGGER_MODULE: Record<AutomationTriggerEvent, AutomationTriggerModule> = {
  "lead.created": "crm",
  "lead.status_changed": "crm",
  "lead.assigned": "crm",
  "lead.score_updated": "crm",
  "deal.created": "crm",
  "deal.stage_changed": "crm",
  "deal.won": "crm",
  "deal.lost": "crm",
  "ticket.created": "support",
  "ticket.assigned": "support",
  "ticket.status_changed": "support",
  "ticket.priority_changed": "support",
  "ticket.message_received": "support",
  "ticket.escalated": "support",
  "sla.breached": "support",
  "invoice.overdue": "finance",
  "invoice.paid": "finance",
  "candidate.application_created": "hr",
  "candidate.stage_changed": "hr",
  "candidate.bgv_status_changed": "hr",
  "interview.scheduled": "hr",
  "interview.completed": "hr",
  "scorecard.submitted": "hr",
  "offer.sent": "hr",
  "offer.accepted": "hr",
  "offer.rejected": "hr",
  "onboarding.started": "hr",
  "onboarding.task_overdue": "hr",
  "onboarding.document_submitted": "hr",
  "onboarding.completed": "hr",
  "leave.requested": "hr",
  "leave.approved": "hr",
  "leave.rejected": "hr",
  "attendance.anomaly": "hr",
  "attendance.late": "hr",
  "resignation.submitted": "hr",
  "resignation.approved": "hr",
  "employee.onboarded": "hr",
  "employee.terminated": "hr",
  "employee.resignation": "hr",
  "certification.expiring": "hr",
  "document.review_requested": "hr",
  "performance.review_cycle_started": "hr",
  "review.cycle_started": "hr",
  "expense.submitted": "hr",
  "expense.approved": "hr",
  "reimbursement.approved": "hr",
  "reimbursement.rejected": "hr",
  "sign.envelope.sent": "sign",
  "sign.envelope.completed": "sign",
  "sign.envelope.declined": "sign",
  "sign.envelope.voided": "sign",
  "sign.envelope.expired": "sign",
  "sign.recipient.completed": "sign",
  "sign.bulk_send.completed": "sign",
};

export interface AutomationTriggerOwnershipDecision {
  readonly trigger: AutomationTriggerEvent;
  readonly alternative: AutomationTriggerModule;
  readonly evidence: string;
}

export const AUTOMATION_TRIGGER_OWNERSHIP_DECISIONS: readonly AutomationTriggerOwnershipDecision[] = [
  {
    trigger: "sla.breached",
    alternative: "hr",
    evidence:
      "Nothing dispatches it. Support owns the only live SLA breach engine (support-sla.service.ts, /support/settings/sla), but the frontend labels it 'Recruitment SLA breached' and HR recruitment runs its own separate engine whose trigger enum already carries SLA_BREACHED (hr/recruitment/dto/automation.schemas.ts).",
  },
  {
    trigger: "expense.submitted",
    alternative: "finance",
    evidence:
      "Dispatched from modules/expenses, whose controllers mount at hr/expenses and gate on hr:expenses:*. The frontend's /accounting/expenses page calls those same hr/expenses routes, so there is one expense surface and its keys are HR's. Report 19b grouped it under Accounting by name family.",
  },
  {
    trigger: "expense.approved",
    alternative: "finance",
    evidence:
      "Never dispatched to this engine; expense.approved appears only as an audit action string. Follows expense.submitted.",
  },
  {
    trigger: "reimbursement.approved",
    alternative: "finance",
    evidence:
      "Dispatched from payroll/hr-payroll/reimbursements.service.ts, reached through PATCH /hr/reimbursements/:id on hr:payroll:view. /accounting/reimbursements is a different entity (reimbursement batches on accounting:reimbursements:*) and dispatches nothing.",
  },
  {
    trigger: "reimbursement.rejected",
    alternative: "finance",
    evidence: "Same dispatch site and gate as reimbursement.approved.",
  },
];

export function moduleForAutomationTrigger(trigger: AutomationTriggerEvent): AutomationTriggerModule {
  return AUTOMATION_TRIGGER_MODULE[trigger];
}

export function automationTriggersForModule(
  module: AutomationTriggerModule,
): readonly AutomationTriggerEvent[] {
  return AUTOMATION_TRIGGERS.filter((trigger) => AUTOMATION_TRIGGER_MODULE[trigger] === module);
}
