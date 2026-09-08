-- Revert 1072: drop the eight membership foreign keys it created.
--
-- Run only during an approved rollback. This reinstates the gap 1072 closed: those
-- eight attribution columns go back to having NO foreign key at all, so removing a
-- membership leaves attendance.user_membership_id and its seven siblings pointing at a
-- row that no longer exists. The Drizzle declarations still say `.onDelete("set null")`
-- afterwards, so `check:referential-action-drift` will report them as unmatched
-- declarations again and `check:membership-parity` will fail on eight registry promises
-- the database no longer keeps — which is the correct signal, not noise to suppress.
--
-- Dropping a foreign key takes ACCESS EXCLUSIVE on the child table only, and does not
-- rewrite it. No data is touched in either direction: 1072 was applied against zero
-- orphans on every column, so nothing was nulled going forward and nothing is restored
-- coming back.

SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE public.attendance DROP CONSTRAINT IF EXISTS fk_attendance_user_actor;
--> statement-breakpoint

ALTER TABLE public.employee_shift_assignments DROP CONSTRAINT IF EXISTS fk_shift_assignments_user_actor;
--> statement-breakpoint

ALTER TABLE public.shift_swap_requests DROP CONSTRAINT IF EXISTS fk_shift_swaps_requester_actor;
--> statement-breakpoint

ALTER TABLE public.shift_swap_requests DROP CONSTRAINT IF EXISTS fk_shift_swaps_target_actor;
--> statement-breakpoint

ALTER TABLE public.shift_swap_requests DROP CONSTRAINT IF EXISTS fk_shift_swaps_approver_actor;
--> statement-breakpoint

ALTER TABLE public.overtime_requests DROP CONSTRAINT IF EXISTS fk_overtime_requests_user_actor;
--> statement-breakpoint

ALTER TABLE public.overtime_requests DROP CONSTRAINT IF EXISTS fk_overtime_requests_approver_actor;
--> statement-breakpoint

ALTER TABLE public.comp_off_balances DROP CONSTRAINT IF EXISTS fk_comp_off_balances_user_actor;
