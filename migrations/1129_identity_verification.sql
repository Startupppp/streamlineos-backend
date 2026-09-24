-- 1129 — Recruitment: identity verification status and the job policy that needs it
--
-- No identity number is stored, in clear or otherwise. `identity_reference` is
-- the vendor's own case id and `identity_last4` is the trailing digits a
-- recruiter uses to confirm they are looking at the right document — which is
-- the whole of what this product needs and the most it may safely hold. A full
-- PAN or Aadhaar in a recruitment database is a liability with no use case
-- behind it.
--
-- `requires_identity_verification` sits on the job rather than the org: some
-- roles are regulated and most are not, and a blanket org setting would either
-- block ordinary hiring or leave the regulated roles ungated.
SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "candidates" ADD COLUMN "identity_status" text;
--> statement-breakpoint
ALTER TABLE "candidates" ADD COLUMN "identity_reference" text;
--> statement-breakpoint
ALTER TABLE "candidates" ADD COLUMN "identity_last4" text;
--> statement-breakpoint
ALTER TABLE "candidates" ADD COLUMN "identity_verified_at" timestamp;
--> statement-breakpoint
ALTER TABLE "candidates" ADD CONSTRAINT "chk_candidates_identity_status"
  CHECK ("identity_status" IS NULL OR "identity_status" IN ('NOT_STARTED','PENDING','VERIFIED','FAILED','UNAVAILABLE')) NOT VALID;
--> statement-breakpoint
-- Four characters, never more. A CHECK rather than a convention, because the
-- column will outlive whoever remembers why it is short.
ALTER TABLE "candidates" ADD CONSTRAINT "chk_candidates_identity_last4"
  CHECK ("identity_last4" IS NULL OR "identity_last4" ~ '^[0-9A-Za-z]{1,4}$') NOT VALID;
--> statement-breakpoint
ALTER TABLE "job_postings" ADD COLUMN "requires_identity_verification" boolean NOT NULL DEFAULT false;
