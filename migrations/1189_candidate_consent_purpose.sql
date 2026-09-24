-- 1189 — Recruitment: what a candidate consented TO, and when it expires
--
-- `consent_at` already records that somebody clicked something on some date.
-- Under DPDP that is not consent: consent is to a stated purpose, for a stated
-- period, against a stated notice. A timestamp on its own cannot be honoured
-- (nothing says what the data may be used for), cannot be evidenced (nothing
-- says what the candidate was shown), and cannot expire (nothing starts a
-- clock). The practical result is a résumé vault that grows forever.
--
-- Four columns, each answering one of those:
--
--   consent_purpose    — what the data may be used for, from a closed list.
--   consent_version    — which published version of the notice was shown.
--   consent_text_hash  — the digest of the exact wording, so a later edit to
--                        the notice cannot silently rewrite what somebody
--                        agreed to.
--   retain_until       — the materialised expiry.
--
-- `retain_until` is stored rather than derived on read so that the date the
-- candidate was TOLD is the date the sweep uses. A policy edit years later must
-- not silently shorten a window somebody was promised, and a derived-on-read
-- date would do exactly that to every historical row at once.
--
-- All four are nullable and no backfill is attempted. Every existing row
-- genuinely has no recorded purpose, and inventing one would pick a retention
-- window on the candidate's behalf — the erasure decision refuses these rows as
-- CONSENT_NOT_RECORDED so they are reviewed rather than swept. A DEFAULT would
-- have been the dishonest option here: it would make the column look answered.
SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "candidate_applications" ADD COLUMN "consent_purpose" text;
--> statement-breakpoint
ALTER TABLE "candidate_applications" ADD COLUMN "consent_version" text;
--> statement-breakpoint
ALTER TABLE "candidate_applications" ADD COLUMN "consent_text_hash" text;
--> statement-breakpoint
-- Bare `timestamp`, deliberately, to match `consent_at` and `applied_at` on
-- this same table. A lone timestamptz column beside them would make every
-- comparison in the retention sweep depend on the server's TZ setting.
ALTER TABLE "candidate_applications" ADD COLUMN "retain_until" timestamp;
--> statement-breakpoint
-- The closed list, as a constraint rather than a convention. A retention sweep
-- cannot classify a purpose it does not recognise, and a row it cannot classify
-- is a row it keeps forever — so free text here becomes indefinite retention
-- within a quarter. NOT VALID because existing rows are all NULL and a full
-- table scan under ACCESS EXCLUSIVE is not worth taking for that.
ALTER TABLE "candidate_applications" ADD CONSTRAINT "chk_candidate_applications_consent_purpose"
  CHECK ("consent_purpose" IS NULL OR "consent_purpose" IN ('THIS_ROLE_ONLY','FUTURE_ROLES','BACKGROUND_VERIFICATION','STATUTORY_RECORD')) NOT VALID;
--> statement-breakpoint
-- A digest, never the notice itself. Without this CHECK the column named
-- "hash" quietly becomes somewhere the full consent wording is pasted, which
-- puts unbounded text back on a row this migration exists to make disposable.
ALTER TABLE "candidate_applications" ADD CONSTRAINT "chk_candidate_applications_consent_text_hash"
  CHECK ("consent_text_hash" IS NULL OR "consent_text_hash" ~ '^[0-9a-f]{64}$') NOT VALID;
--> statement-breakpoint
-- A record carrying an expiry must also carry the purpose that justifies it.
-- The pair is what the sweep reads; either half alone is unactionable.
ALTER TABLE "candidate_applications" ADD CONSTRAINT "chk_candidate_applications_retention_pair"
  CHECK ("retain_until" IS NULL OR "consent_purpose" IS NOT NULL) NOT VALID;
--> statement-breakpoint
-- The retention sweep's access path: due rows for one tenant, oldest first.
-- org_id leads, per the tenant-index rule, and the partial predicate keeps the
-- index off the rows that have no clock yet.
CREATE INDEX IF NOT EXISTS "idx_candidate_applications_org_retain_until"
  ON "candidate_applications" ("org_id", "retain_until")
  WHERE "retain_until" IS NOT NULL;
