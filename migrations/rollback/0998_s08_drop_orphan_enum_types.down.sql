-- 0998 DOWN — recreates the thirteen orphan enum types with their original labels
-- and label order, so a catalog comparison against a database that never ran 0998
-- comes back identical.

SET lock_timeout = '5s';
--> statement-breakpoint
CREATE TYPE public.automation_run_status AS ENUM ('success', 'failed', 'skipped');
--> statement-breakpoint
CREATE TYPE public.automation_trigger AS ENUM ('lead.created', 'lead.status_changed', 'lead.assigned', 'lead.score_updated', 'deal.created', 'deal.stage_changed', 'deal.won', 'deal.lost', 'ticket.created', 'ticket.assigned', 'ticket.status_changed', 'ticket.priority_changed', 'ticket.message_received', 'ticket.escalated', 'invoice.overdue', 'invoice.paid', 'candidate.application_created', 'candidate.stage_changed', 'candidate.bgv_status_changed', 'interview.scheduled', 'interview.completed', 'scorecard.submitted', 'offer.sent', 'offer.accepted', 'offer.rejected', 'sla.breached', 'onboarding.started', 'onboarding.task_overdue', 'onboarding.document_submitted', 'onboarding.completed', 'leave.requested', 'leave.approved', 'leave.rejected', 'attendance.anomaly', 'attendance.late', 'resignation.submitted', 'resignation.approved', 'employee.onboarded', 'employee.terminated', 'employee.resignation', 'certification.expiring', 'document.review_requested', 'performance.review_cycle_started', 'review.cycle_started', 'expense.submitted', 'expense.approved', 'reimbursement.approved', 'reimbursement.rejected', 'sign.envelope.sent', 'sign.envelope.completed', 'sign.envelope.declined', 'sign.envelope.voided', 'sign.envelope.expired', 'sign.recipient.completed', 'sign.bulk_send.completed');
--> statement-breakpoint
CREATE TYPE public.branch_status AS ENUM ('ACTIVE', 'INACTIVE');
--> statement-breakpoint
CREATE TYPE public.crm_event_status AS ENUM ('planning', 'confirmed', 'completed');
--> statement-breakpoint
CREATE TYPE public.deal_activity_type AS ENUM ('stage_change', 'note', 'call', 'email', 'meeting', 'document');
--> statement-breakpoint
CREATE TYPE public.delivery_status AS ENUM ('QUEUED', 'PROCESSING', 'DELIVERED', 'FAILED', 'EXPIRED');
--> statement-breakpoint
CREATE TYPE public.hr_automation_run_status AS ENUM ('success', 'partial', 'failed', 'skipped');
--> statement-breakpoint
CREATE TYPE public.hr_custom_field_type AS ENUM ('text', 'number', 'date', 'select', 'multi_select', 'boolean', 'file', 'employee_ref', 'department_ref', 'currency');
--> statement-breakpoint
CREATE TYPE public.onboarding_flow_task_category AS ENUM ('profile', 'document', 'training', 'system_access', 'equipment', 'policy', 'module_setup', 'guided_action', 'payment_setup');
--> statement-breakpoint
CREATE TYPE public.onboarding_flow_task_status AS ENUM ('todo', 'in_progress', 'done', 'skipped');
--> statement-breakpoint
CREATE TYPE public.payroll_status AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PAID');
--> statement-breakpoint
CREATE TYPE public.principal_group_type AS ENUM ('department', 'team', 'custom');
--> statement-breakpoint
CREATE TYPE public.support_source_channel AS ENUM ('web', 'portal', 'email', 'chat', 'whatsapp', 'sms', 'api', 'internal');
