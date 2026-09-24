-- 1125 — Recruitment: interview transcripts, on the interview
--
-- Columns on `interviews` rather than a transcripts table: there is exactly one
-- transcript per interview, nothing joins to it, and `hr_*` is frozen at its
-- current table count.
--
-- `transcript_consent_at` is NOT a boolean. A recording of a conversation is
-- personal data belonging to two people, and answering "did they agree" needs
-- the moment it was recorded, not just that somebody ticked something once.
-- `transcript_retain_until` is stamped when the transcript is stored, so the
-- retention decision is taken with the consent rather than inferred later.
SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "interviews" ADD COLUMN "transcript" text;
--> statement-breakpoint
ALTER TABLE "interviews" ADD COLUMN "transcript_source" text;
--> statement-breakpoint
ALTER TABLE "interviews" ADD COLUMN "transcript_consent_at" timestamp;
--> statement-breakpoint
ALTER TABLE "interviews" ADD COLUMN "transcript_retain_until" timestamp;
--> statement-breakpoint
ALTER TABLE "interviews" ADD COLUMN "transcript_stored_at" timestamp;
--> statement-breakpoint
ALTER TABLE "interviews" ADD COLUMN "transcript_stored_by_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "interviews" ADD CONSTRAINT "fk_interviews_transcript_stored_by"
  FOREIGN KEY ("org_id", "transcript_stored_by_membership_id")
  REFERENCES "organization_members"("org_id", "id") ON DELETE RESTRICT NOT VALID;
--> statement-breakpoint
ALTER TABLE "interviews" VALIDATE CONSTRAINT "fk_interviews_transcript_stored_by";
--> statement-breakpoint
-- The retention sweep asks "which transcripts are past their date"; without
-- this it reads every interview in the organisation to find out.
CREATE INDEX IF NOT EXISTS "idx_interviews_transcript_retention"
  ON "interviews" ("org_id", "transcript_retain_until")
  WHERE "transcript" IS NOT NULL;
