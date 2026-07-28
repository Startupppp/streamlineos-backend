SET statement_timeout = 0;
-- 0347 — FK repairs: type mismatches and missing foreign-key constraints
-- =============================================================================
-- A. TYPE MISMATCHES
--
--   organizations.purge_scheduled_by was integer but users.id is text (UUID).
--   No existing integer value can be a valid user ID, so we null them before
--   changing the type, then add the FK.
--
-- B. MISSING FK CONSTRAINTS — types already matched, constraints absent
--
--   Each constraint is named explicitly.
--   ON DELETE choices:
--     CASCADE   — child row is meaningless without parent (e.g. installations)
--     RESTRICT  — deletion must be blocked (e.g. product with named owner)
--     SET NULL  — reference becomes optional; parent may legitimately be removed
--
-- SQL-only constraints (no Drizzle .references() added due to circular imports
-- or architectural violations):
--   hr_employments → hr_job_roles / hr_job_levels
--       core-org.ts imports from core-people.ts; adding the reverse creates a
--       cycle.  Constraint enforced at DB level only.
--   support_tickets → support_queues
--       support-workspace.ts imports from tickets.ts; the reverse import is
--       circular.  Constraint enforced at DB level only.
--   calendar_events → deals / leads
--       common/shared.ts must not import from the crm/ module (common↑crm
--       dependency inversion).  Constraints enforced at DB level only.
--   timesheet_rates → tickets
--       build/tasks.ts already imports from timesheets; adding the reverse
--       creates a cycle.  Constraint enforced at DB level only.
--
-- Reported — not applied here because a concurrent agent owns the target:
--   users.branch_id (integer → text) — target table (org_units) confirmed but
--       org_branches is still present; apply after the concurrent
--       drop-org-branches migration lands.
--   hr_employments.location_id — concurrent agent is dropping hr_locations;
--       apply or drop this column after that migration lands.
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- A-1. organizations.purge_scheduled_by  integer → text → FK → users(id)
-- ─────────────────────────────────────────────────────────────────────────────
-- Existing integer values cannot be valid user UUIDs; null them first.
UPDATE "organizations" SET "purge_scheduled_by" = NULL WHERE "purge_scheduled_by" IS NOT NULL;
--> statement-breakpoint

ALTER TABLE "organizations" ALTER COLUMN "purge_scheduled_by" TYPE text;
--> statement-breakpoint

ALTER TABLE "organizations"
  ADD CONSTRAINT "fk_organizations_purge_scheduled_by"
  FOREIGN KEY ("purge_scheduled_by")
  REFERENCES "users"("id")
  ON DELETE SET NULL;
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- B-1. invitations.inviter_membership_id → organization_members(id)
--       SET NULL: inviter leaving must not cascade-delete the invitation.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "invitations"
  ADD CONSTRAINT "fk_invitations_inviter_membership"
  FOREIGN KEY ("inviter_membership_id")
  REFERENCES "organization_members"("id")
  ON DELETE SET NULL;
--> statement-breakpoint

-- B-2. invitations.accepted_membership_id → organization_members(id)
--       SET NULL: historical acceptance record survives member removal.
ALTER TABLE "invitations"
  ADD CONSTRAINT "fk_invitations_accepted_membership"
  FOREIGN KEY ("accepted_membership_id")
  REFERENCES "organization_members"("id")
  ON DELETE SET NULL;
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- B-3. hr_employments.job_role_id → hr_job_roles(id)
--       SET NULL: employment survives job-role catalog entry removal.
--       (SQL-only — Drizzle reference omitted: core-org imports core-people.)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "hr_employments"
  ADD CONSTRAINT "fk_hr_employments_job_role"
  FOREIGN KEY ("job_role_id")
  REFERENCES "hr_job_roles"("id")
  ON DELETE SET NULL;
--> statement-breakpoint

-- B-4. hr_employments.job_level_id → hr_job_levels(id)
--       SET NULL: same rationale as job_role_id.
ALTER TABLE "hr_employments"
  ADD CONSTRAINT "fk_hr_employments_job_level"
  FOREIGN KEY ("job_level_id")
  REFERENCES "hr_job_levels"("id")
  ON DELETE SET NULL;
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- B-5. worker_engagements.job_role_id → hr_job_roles(id)
--       SET NULL: engagement survives job-role removal.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "worker_engagements"
  ADD CONSTRAINT "fk_worker_engagements_job_role"
  FOREIGN KEY ("job_role_id")
  REFERENCES "hr_job_roles"("id")
  ON DELETE SET NULL;
--> statement-breakpoint

-- B-6. worker_engagements.job_level_id → hr_job_levels(id)
--       SET NULL: same rationale.
ALTER TABLE "worker_engagements"
  ADD CONSTRAINT "fk_worker_engagements_job_level"
  FOREIGN KEY ("job_level_id")
  REFERENCES "hr_job_levels"("id")
  ON DELETE SET NULL;
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- B-7. tickets.recurrence_parent_id → tickets(id)  (self-reference)
--       SET NULL: deleting a recurring parent orphans the children gracefully.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "tickets"
  ADD CONSTRAINT "fk_tickets_recurrence_parent"
  FOREIGN KEY ("recurrence_parent_id")
  REFERENCES "tickets"("id")
  ON DELETE SET NULL;
--> statement-breakpoint

-- B-8. tickets.customer_id → clients(id)
--       SET NULL: ticket survives client deletion.
ALTER TABLE "tickets"
  ADD CONSTRAINT "fk_tickets_customer"
  FOREIGN KEY ("customer_id")
  REFERENCES "clients"("id")
  ON DELETE SET NULL;
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- B-9. managed_products.owner_membership_id → organization_members(org_id, id)
--       Composite FK prevents cross-tenant ownership.
--       RESTRICT: a member who owns a product must be deactivated, not deleted.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "managed_products"
  ADD CONSTRAINT "fk_managed_products_owner_membership"
  FOREIGN KEY ("org_id", "owner_membership_id")
  REFERENCES "organization_members"("org_id", "id")
  ON DELETE RESTRICT;
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- B-10. support_tickets.queue_id → support_queues(id)
--        SET NULL: ticket survives queue deletion (remains unqueued).
--        (SQL-only — support-workspace.ts imports from tickets.ts; circular.)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "support_tickets"
  ADD CONSTRAINT "fk_support_tickets_queue"
  FOREIGN KEY ("queue_id")
  REFERENCES "support_queues"("id")
  ON DELETE SET NULL;
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- B-11. notification_audit_logs.notification_id → notifications(id)
--        SET NULL: audit record is historical evidence and must not be deleted.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "notification_audit_logs"
  ADD CONSTRAINT "fk_notification_audit_logs_notification"
  FOREIGN KEY ("notification_id")
  REFERENCES "notifications"("id")
  ON DELETE SET NULL;
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- B-12. calendar_events.linked_deal_id → deals(id)
--        SET NULL: event survives deal deletion.
--        (SQL-only — common/shared.ts must not import from crm/.)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "calendar_events"
  ADD CONSTRAINT "fk_calendar_events_linked_deal"
  FOREIGN KEY ("linked_deal_id")
  REFERENCES "deals"("id")
  ON DELETE SET NULL;
--> statement-breakpoint

-- B-13. calendar_events.linked_lead_id → leads(id)
--        SET NULL: same rationale.
ALTER TABLE "calendar_events"
  ADD CONSTRAINT "fk_calendar_events_linked_lead"
  FOREIGN KEY ("linked_lead_id")
  REFERENCES "leads"("id")
  ON DELETE SET NULL;
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- B-14. app_installations.app_id → marketplace_apps(id)
--        RESTRICT: prevents silently deleting a marketplace app that orgs use;
--        an admin must remove all installations first.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "app_installations"
  ADD CONSTRAINT "fk_app_installations_app"
  FOREIGN KEY ("app_id")
  REFERENCES "marketplace_apps"("id")
  ON DELETE RESTRICT;
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- B-15. org_ai_credits.auto_top_up_pack_id → ai_credit_packs(id)
--        SET NULL: if a pack is retired, auto-top-up is disabled gracefully.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "org_ai_credits"
  ADD CONSTRAINT "fk_org_ai_credits_auto_top_up_pack"
  FOREIGN KEY ("auto_top_up_pack_id")
  REFERENCES "ai_credit_packs"("id")
  ON DELETE SET NULL;
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- B-16. timesheet_rates.client_id → clients(id)
--        SET NULL: rate card entry survives client deletion.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "timesheet_rates"
  ADD CONSTRAINT "fk_timesheet_rates_client"
  FOREIGN KEY ("client_id")
  REFERENCES "clients"("id")
  ON DELETE SET NULL;
--> statement-breakpoint

-- B-17. timesheet_rates.task_id → tickets(id)
--        SET NULL: rate entry survives ticket deletion.
--        (SQL-only — build/tasks.ts imports from timesheets/; circular.)
ALTER TABLE "timesheet_rates"
  ADD CONSTRAINT "fk_timesheet_rates_task"
  FOREIGN KEY ("task_id")
  REFERENCES "tickets"("id")
  ON DELETE SET NULL;
