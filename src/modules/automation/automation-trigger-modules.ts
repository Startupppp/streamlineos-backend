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

export function moduleForAutomationTrigger(trigger: AutomationTriggerEvent): AutomationTriggerModule {
  return AUTOMATION_TRIGGER_MODULE[trigger];
}

export function automationTriggersForModule(
  module: AutomationTriggerModule,
): readonly AutomationTriggerEvent[] {
  return AUTOMATION_TRIGGERS.filter((trigger) => AUTOMATION_TRIGGER_MODULE[trigger] === module);
}
