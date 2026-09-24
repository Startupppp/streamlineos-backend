-- 1187 — Recruitment: why a candidate was rejected
--
-- A reject used to be a drag onto a column: it moved the stage, it could send
-- an email, and it recorded nothing about why. The only account of why anybody
-- was turned down was whatever the recruiter remembered, which costs a hiring
-- team its funnel analysis and costs the candidate an employer that can answer
-- a DPDP question about a decision it made.
--
-- `rejection_reason` holds a code from a closed list, never a label. Labels are
-- prose a team rewrites — "Notice period" becomes "Notice period too long" the
-- first time somebody finds it ambiguous — and a stored label freezes each
-- quarter's wording into that quarter's rows, so grouping later returns one
-- reason as two categories. Codes keep a series a series, and renaming a label
-- stays a display change.
--
-- `rejection_note` is the free text, and it is required for exactly one code.
-- `OTHER` is the escape hatch, and an unexplained escape hatch is where a
-- required field goes to die: one click and the catalog means nothing again.
-- The pairing is a CHECK rather than a convention, because the application will
-- be rewritten several times and the column will outlive every rewrite.
--
-- Both constraints are NOT VALID: they bind every new row while skipping the
-- scan of an existing table, and every existing row is NULL in both columns
-- anyway — the reason is required going forward, not retrofitted onto history
-- nobody recorded.
SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "candidates" ADD COLUMN "rejection_reason" text;
--> statement-breakpoint
ALTER TABLE "candidates" ADD COLUMN "rejection_note" text;
--> statement-breakpoint
ALTER TABLE "candidates" ADD CONSTRAINT "chk_candidates_rejection_reason"
  CHECK ("rejection_reason" IS NULL OR "rejection_reason" IN ('SKILLS_MISMATCH','EXPERIENCE_MISMATCH','COMPENSATION','LOCATION','NOTICE_PERIOD','WITHDREW','POSITION_CLOSED','FAILED_ASSESSMENT','BACKGROUND_CHECK','DUPLICATE','OTHER')) NOT VALID;
--> statement-breakpoint
-- OTHER carries its note or it is not a reason at all.
ALTER TABLE "candidates" ADD CONSTRAINT "chk_candidates_rejection_other_note"
  CHECK ("rejection_reason" IS DISTINCT FROM 'OTHER' OR btrim(coalesce("rejection_note", '')) <> '') NOT VALID;
