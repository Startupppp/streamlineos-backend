-- Rollback for 1231. The table holds only refusals of a first-visit offer, so
-- dropping it makes every organisation eligible for the offer again; no other
-- data is derived from it.
SET lock_timeout = '5s';
--> statement-breakpoint

DROP TABLE IF EXISTS "public"."hr_leave_policy_template_dismissals";
--> statement-breakpoint
