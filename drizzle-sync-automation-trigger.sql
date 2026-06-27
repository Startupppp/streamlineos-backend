-- Additive sync of the automation_trigger enum to match the Drizzle schema
-- (src/db/schema/automation/rules.ts). The live DB had only 4 of the ~40
-- declared values, so automation events such as leave.approved /
-- resignation.submitted / candidate.stage_changed errored at query time.
-- ADDITIVE ONLY, idempotent (IF NOT EXISTS). Applied to the live DB 2026-06-27.
-- Note: ALTER TYPE ... ADD VALUE must run outside a transaction; run statements individually.
ALTER TYPE automation_trigger ADD VALUE IF NOT EXISTS 'lead.status_changed';
ALTER TYPE automation_trigger ADD VALUE IF NOT EXISTS 'lead.assigned';
ALTER TYPE automation_trigger ADD VALUE IF NOT EXISTS 'lead.score_updated';
ALTER TYPE automation_trigger ADD VALUE IF NOT EXISTS 'deal.created';
ALTER TYPE automation_trigger ADD VALUE IF NOT EXISTS 'deal.won';
ALTER TYPE automation_trigger ADD VALUE IF NOT EXISTS 'deal.lost';
ALTER TYPE automation_trigger ADD VALUE IF NOT EXISTS 'ticket.assigned';
ALTER TYPE automation_trigger ADD VALUE IF NOT EXISTS 'ticket.status_changed';
ALTER TYPE automation_trigger ADD VALUE IF NOT EXISTS 'ticket.escalated';
ALTER TYPE automation_trigger ADD VALUE IF NOT EXISTS 'invoice.paid';
ALTER TYPE automation_trigger ADD VALUE IF NOT EXISTS 'candidate.application_created';
ALTER TYPE automation_trigger ADD VALUE IF NOT EXISTS 'candidate.stage_changed';
ALTER TYPE automation_trigger ADD VALUE IF NOT EXISTS 'candidate.bgv_status_changed';
ALTER TYPE automation_trigger ADD VALUE IF NOT EXISTS 'interview.scheduled';
ALTER TYPE automation_trigger ADD VALUE IF NOT EXISTS 'interview.completed';
ALTER TYPE automation_trigger ADD VALUE IF NOT EXISTS 'scorecard.submitted';
ALTER TYPE automation_trigger ADD VALUE IF NOT EXISTS 'offer.sent';
ALTER TYPE automation_trigger ADD VALUE IF NOT EXISTS 'offer.accepted';
ALTER TYPE automation_trigger ADD VALUE IF NOT EXISTS 'offer.rejected';
ALTER TYPE automation_trigger ADD VALUE IF NOT EXISTS 'sla.breached';
ALTER TYPE automation_trigger ADD VALUE IF NOT EXISTS 'onboarding.started';
ALTER TYPE automation_trigger ADD VALUE IF NOT EXISTS 'onboarding.task_overdue';
ALTER TYPE automation_trigger ADD VALUE IF NOT EXISTS 'onboarding.document_submitted';
ALTER TYPE automation_trigger ADD VALUE IF NOT EXISTS 'onboarding.completed';
ALTER TYPE automation_trigger ADD VALUE IF NOT EXISTS 'leave.requested';
ALTER TYPE automation_trigger ADD VALUE IF NOT EXISTS 'leave.approved';
ALTER TYPE automation_trigger ADD VALUE IF NOT EXISTS 'leave.rejected';
ALTER TYPE automation_trigger ADD VALUE IF NOT EXISTS 'attendance.anomaly';
ALTER TYPE automation_trigger ADD VALUE IF NOT EXISTS 'attendance.late';
ALTER TYPE automation_trigger ADD VALUE IF NOT EXISTS 'resignation.submitted';
ALTER TYPE automation_trigger ADD VALUE IF NOT EXISTS 'resignation.approved';
ALTER TYPE automation_trigger ADD VALUE IF NOT EXISTS 'employee.onboarded';
ALTER TYPE automation_trigger ADD VALUE IF NOT EXISTS 'employee.terminated';
ALTER TYPE automation_trigger ADD VALUE IF NOT EXISTS 'employee.resignation';
ALTER TYPE automation_trigger ADD VALUE IF NOT EXISTS 'certification.expiring';
ALTER TYPE automation_trigger ADD VALUE IF NOT EXISTS 'document.review_requested';
