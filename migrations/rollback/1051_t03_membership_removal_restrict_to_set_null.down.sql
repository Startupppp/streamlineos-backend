-- 1051 DOWN — returns both foreign keys to ON DELETE RESTRICT.
--
-- @reopens-a-defect: this is not a neutral reversal. RESTRICT is what BLOCKED member
-- removal outright — a member who has ever reviewed someone or logged a mood check-in
-- cannot be hard-deleted while these constraints are RESTRICT, and nothing in
-- org-member-departure.service.ts clears either pointer first. Running this restores that
-- blocker. Revert the Drizzle declarations in src/db/schema/hr/performance.ts and
-- src/db/schema/hr/engagement-extras.ts in the same change, or the declaration and the
-- catalog disagree again.
--
-- Rows whose pointer was already nulled by the forward migration's behaviour are NOT
-- restored: the membership row they pointed at no longer exists, so RESTRICT cannot be
-- validated against it. VALIDATE below therefore only proves the surviving rows.

SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE "performance_reviews"
  DROP CONSTRAINT IF EXISTS "fk_performance_reviews_reviewer_actor";
--> statement-breakpoint

ALTER TABLE "performance_reviews"
  ADD CONSTRAINT "fk_performance_reviews_reviewer_actor"
  FOREIGN KEY ("org_id", "reviewer_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint

ALTER TABLE "performance_reviews"
  VALIDATE CONSTRAINT "fk_performance_reviews_reviewer_actor";
--> statement-breakpoint

ALTER TABLE "hr_mood_checkins"
  DROP CONSTRAINT IF EXISTS "fk_hr_mood_checkins_user_actor";
--> statement-breakpoint

ALTER TABLE "hr_mood_checkins"
  ADD CONSTRAINT "fk_hr_mood_checkins_user_actor"
  FOREIGN KEY ("org_id", "user_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint

ALTER TABLE "hr_mood_checkins"
  VALIDATE CONSTRAINT "fk_hr_mood_checkins_user_actor";
