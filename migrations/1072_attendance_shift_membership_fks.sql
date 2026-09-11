-- 1072: create the eight membership foreign keys the schema has always declared
--       and the database has never had.
--
-- Found by `check:membership-artifact-parity`, comparing MEMBERSHIP_ARTIFACTS to
-- pg_constraint at journal head. Eight entries are `mechanism: "database-cascade"`
-- with reasons that say, in so many words, "the declared SET NULL foreign key
-- preserves the row while clearing the departed member pointer". No such foreign
-- key existed. The Drizzle declarations are all there --
-- fk_attendance_user_actor and its seven siblings, every one carrying
-- .onDelete("set null") -- so this is a migration that was never written, not a
-- design decision.
--
-- WHAT WAS ACTUALLY BROKEN
--   Nothing enforced these columns, so removing a membership left
--   attendance.user_membership_id (and seven more) pointing at a row that no
--   longer exists. Every later read resolving that pointer got nothing back, and
--   the membership-removal flow reported success while leaving dangling
--   attribution behind. `check:referential-action-drift` could not see it: an
--   FK that exists on ONE side only lands in its "unmatched declarations 104
--   (reported, never failed)" bucket by design, because a declaration with no
--   catalog counterpart has no action to compare.
--
-- SET NULL CARRIES A COLUMN LIST, DELIBERATELY
--   These are composite (org_id, <member>_membership_id) keys and org_id is NOT
--   NULL. A bare ON DELETE SET NULL nulls EVERY column of the key, so the first
--   membership deletion would raise 23502 on org_id instead of clearing the
--   pointer. The column list confines the null to the membership column.
--
-- ORPHAN CHECK, RUN BEFORE WRITING THIS, on a database at head:
--   attendance.user_membership_id                 rows=10236 non-null=10178 orphans=0
--   employee_shift_assignments.user_membership_id rows=0     non-null=0     orphans=0
--   shift_swap_requests.requester_membership_id   rows=5     non-null=5     orphans=0
--   shift_swap_requests.target_membership_id      rows=5     non-null=5     orphans=0
--   shift_swap_requests.approver_membership_id    rows=5     non-null=1     orphans=0
--   overtime_requests.user_membership_id          rows=1     non-null=0     orphans=0
--   overtime_requests.approver_membership_id      rows=1     non-null=1     orphans=0
--   comp_off_balances.user_membership_id          rows=0     non-null=0     orphans=0
-- Zero orphans, so VALIDATE cannot fail on this data. It is still split from the
-- ADD so the ACCESS EXCLUSIVE window does not include the scan -- attendance is
-- the largest of the five and grows without bound.
--
-- Every child column already has a supporting index ending in
-- _membership / _membership_date, so the new keys add no unindexed scan.

SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE public.attendance
  ADD CONSTRAINT fk_attendance_user_actor
  FOREIGN KEY (org_id, user_membership_id)
  REFERENCES public.organization_members(org_id, id)
  ON DELETE SET NULL (user_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE public.attendance VALIDATE CONSTRAINT fk_attendance_user_actor;
--> statement-breakpoint

ALTER TABLE public.employee_shift_assignments
  ADD CONSTRAINT fk_shift_assignments_user_actor
  FOREIGN KEY (org_id, user_membership_id)
  REFERENCES public.organization_members(org_id, id)
  ON DELETE SET NULL (user_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE public.employee_shift_assignments VALIDATE CONSTRAINT fk_shift_assignments_user_actor;
--> statement-breakpoint

ALTER TABLE public.shift_swap_requests
  ADD CONSTRAINT fk_shift_swaps_requester_actor
  FOREIGN KEY (org_id, requester_membership_id)
  REFERENCES public.organization_members(org_id, id)
  ON DELETE SET NULL (requester_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE public.shift_swap_requests VALIDATE CONSTRAINT fk_shift_swaps_requester_actor;
--> statement-breakpoint

ALTER TABLE public.shift_swap_requests
  ADD CONSTRAINT fk_shift_swaps_target_actor
  FOREIGN KEY (org_id, target_membership_id)
  REFERENCES public.organization_members(org_id, id)
  ON DELETE SET NULL (target_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE public.shift_swap_requests VALIDATE CONSTRAINT fk_shift_swaps_target_actor;
--> statement-breakpoint

ALTER TABLE public.shift_swap_requests
  ADD CONSTRAINT fk_shift_swaps_approver_actor
  FOREIGN KEY (org_id, approver_membership_id)
  REFERENCES public.organization_members(org_id, id)
  ON DELETE SET NULL (approver_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE public.shift_swap_requests VALIDATE CONSTRAINT fk_shift_swaps_approver_actor;
--> statement-breakpoint

ALTER TABLE public.overtime_requests
  ADD CONSTRAINT fk_overtime_requests_user_actor
  FOREIGN KEY (org_id, user_membership_id)
  REFERENCES public.organization_members(org_id, id)
  ON DELETE SET NULL (user_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE public.overtime_requests VALIDATE CONSTRAINT fk_overtime_requests_user_actor;
--> statement-breakpoint

ALTER TABLE public.overtime_requests
  ADD CONSTRAINT fk_overtime_requests_approver_actor
  FOREIGN KEY (org_id, approver_membership_id)
  REFERENCES public.organization_members(org_id, id)
  ON DELETE SET NULL (approver_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE public.overtime_requests VALIDATE CONSTRAINT fk_overtime_requests_approver_actor;
--> statement-breakpoint

ALTER TABLE public.comp_off_balances
  ADD CONSTRAINT fk_comp_off_balances_user_actor
  FOREIGN KEY (org_id, user_membership_id)
  REFERENCES public.organization_members(org_id, id)
  ON DELETE SET NULL (user_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE public.comp_off_balances VALIDATE CONSTRAINT fk_comp_off_balances_user_actor;
