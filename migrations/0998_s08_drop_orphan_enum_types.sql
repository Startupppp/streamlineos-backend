-- Thirteen enum types exist in the catalog, are used by no column of any table,
-- view, materialised view or composite type, are declared by no pgEnum in
-- db/schema, and are named nowhere in src. They are the residue of columns that
-- later migrations retyped or dropped; dropping a column never drops the type it
-- used. Each one shows up in every schema diff and in drizzle-kit's introspection
-- as a type the declaration does not know about.
--
-- This list is deliberately narrower than the "63 enums with no column" figure in
-- report 07. Fifty of those are declared in Drizzle for tables in the SQL-managed
-- HR set or the 105 undeclared-in-Drizzle set, so they become droppable only when
-- those resolve. The three left out here are crm_lead_status and hr_position_status
-- (still declared by a live pgEnum) and task_type (a live string literal in the CRM
-- metadata seed, unrelated to the type but a name a text scan would trip over).
--
-- DROP TYPE without CASCADE is the safety: if any dependency has appeared since
-- this was derived, the statement fails with 2BP01 rather than silently removing
-- the dependent object.

SET lock_timeout = '5s';
--> statement-breakpoint
DROP TYPE IF EXISTS public.automation_run_status;
--> statement-breakpoint
DROP TYPE IF EXISTS public.automation_trigger;
--> statement-breakpoint
DROP TYPE IF EXISTS public.branch_status;
--> statement-breakpoint
DROP TYPE IF EXISTS public.crm_event_status;
--> statement-breakpoint
DROP TYPE IF EXISTS public.deal_activity_type;
--> statement-breakpoint
DROP TYPE IF EXISTS public.delivery_status;
--> statement-breakpoint
DROP TYPE IF EXISTS public.hr_automation_run_status;
--> statement-breakpoint
DROP TYPE IF EXISTS public.hr_custom_field_type;
--> statement-breakpoint
DROP TYPE IF EXISTS public.onboarding_flow_task_category;
--> statement-breakpoint
DROP TYPE IF EXISTS public.onboarding_flow_task_status;
--> statement-breakpoint
DROP TYPE IF EXISTS public.payroll_status;
--> statement-breakpoint
DROP TYPE IF EXISTS public.principal_group_type;
--> statement-breakpoint
DROP TYPE IF EXISTS public.support_source_channel;
