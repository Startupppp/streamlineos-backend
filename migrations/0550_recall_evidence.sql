-- D4 — the evidence a recall was executed against.
--
-- A recall is a regulated act, and what makes one defensible is the picture
-- that was on the screen when somebody pressed the button: which lots, how much
-- on hand, how much in transit, which customers already have it. Recording only
-- the outcome ("14 lots recalled") loses the question that was asked and the
-- answer that justified it.
--
-- `evidence_version` is the content hash the simulate endpoint returned and the
-- execute re-verified; `evidence_snapshot` is that impact set in full. Both are
-- nullable: a recall raised from an explicit list of lot ids asserts nothing
-- about a wider picture, so it has no evidence to carry.
--
-- Additive and lock-cheap: two nullable columns with no default, so this is a
-- catalogue-only change that does not rewrite the table.

SET lock_timeout = '5s';

ALTER TABLE "inv_recall_events" ADD COLUMN IF NOT EXISTS "evidence_version" text;
--> statement-breakpoint
ALTER TABLE "inv_recall_events" ADD COLUMN IF NOT EXISTS "evidence_snapshot" jsonb;
