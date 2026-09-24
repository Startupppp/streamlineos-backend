-- 1188 — Recruitment: the structured CTC behind an offer
--
-- `offered_salary` stays exactly where it is. It is live — the hire handoff
-- builds a salary structure from it, the negotiation flow counters against it
-- and the offer letter quotes it — so these six columns are additive beside it,
-- never a replacement for it. Every offer written before this migration keeps
-- working with all six null, which is the honest reading: nobody entered a
-- breakdown, as distinct from a breakdown of zero.
--
-- Nullable for the same reason, and permanently so. A zero variable ("this role
-- has no performance bonus") and an unentered variable ("the recruiter has not
-- filled this in yet") are different facts, and a NOT NULL DEFAULT 0 would
-- publish the first while meaning the second — to the candidate deciding on it.
--
-- numeric(15,2) matches `offered_salary` exactly, because the two are summed
-- against each other. HR money in this codebase is decimal major; the GL's
-- integer `*_minor` convention does NOT apply here, and mixing them is a 100x
-- error. The arithmetic lives in
-- `src/modules/hr/recruitment/compensation/ctc-breakdown.ts`, which parses these
-- strings into integer paise rather than floats.
--
-- WHY NO CHECK RECONCILING THE SUM AGAINST `offered_salary`. It is tempting and
-- it is wrong here. `offered_salary` is patched on its own by the negotiation
-- and terms-update paths, so a constraint would reject those writes as a raw
-- 23514 — a 500 with no readable message, on a partially-entered draft that is
-- allowed to be inconsistent while a recruiter is still typing. The
-- reconciliation is enforced in the service at the two moments it matters
-- (creation and approval, approval being the send) via
-- `reconcileCtcAgainstOfferedSalary`, where it can be a 400 that names the
-- difference.
SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "candidate_offers" ADD COLUMN "ctc_fixed" numeric(15, 2);
--> statement-breakpoint
ALTER TABLE "candidate_offers" ADD COLUMN "ctc_variable" numeric(15, 2);
--> statement-breakpoint
ALTER TABLE "candidate_offers" ADD COLUMN "ctc_joining_bonus" numeric(15, 2);
--> statement-breakpoint
ALTER TABLE "candidate_offers" ADD COLUMN "ctc_equity_value" numeric(15, 2);
--> statement-breakpoint
ALTER TABLE "candidate_offers" ADD COLUMN "ctc_employer_pf" numeric(15, 2);
--> statement-breakpoint
ALTER TABLE "candidate_offers" ADD COLUMN "ctc_gratuity" numeric(15, 2);
--> statement-breakpoint
-- A negative component is never a term of an offer, it is a data-entry slip, and
-- it subtracts from the total silently. One constraint over all six rather than
-- six, because it is one rule. NOT VALID: no existing row can violate it (they
-- are all null) and validating would take the table.
ALTER TABLE "candidate_offers" ADD CONSTRAINT "chk_candidate_offers_ctc_non_negative"
  CHECK (
    ("ctc_fixed" IS NULL OR "ctc_fixed" >= 0)
    AND ("ctc_variable" IS NULL OR "ctc_variable" >= 0)
    AND ("ctc_joining_bonus" IS NULL OR "ctc_joining_bonus" >= 0)
    AND ("ctc_equity_value" IS NULL OR "ctc_equity_value" >= 0)
    AND ("ctc_employer_pf" IS NULL OR "ctc_employer_pf" >= 0)
    AND ("ctc_gratuity" IS NULL OR "ctc_gratuity" >= 0)
  ) NOT VALID;
