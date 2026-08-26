-- Custom SQL migration file, put your code below! --

-- The importer gets an entity dimension.
--
-- 0229 and 0280 built one importer, and it was party-shaped all the way down:
-- a flat field vocabulary, a plan whose only notion of identity was the party
-- duplicate scorer, and a commit that inserted `business_parties` directly.
-- Subjects, pipelines and activities are not a second importer -- they are the
-- same plan, preview, durable commit and thirty-day undo with the vocabulary and
-- the writer as parameters. These columns are those parameters.
--
-- `crm_imports.target_entity` is the discriminator, and it deliberately lives on
-- the IMPORT rather than on each row. One file is for one entity, decided once
-- at preview alongside the column mapping and for the same reason: re-deciding
-- on read would let the commit be a different import from the one the tenant
-- approved. Keeping it off the rows is also what stops `crm_import_rows`
-- becoming the `entity_type` + `entity_id` pair this repository bans -- no row
-- can disagree with its parent, because no row carries the question.
--
-- `target_subject_type_id` exists because `subjects.subject_type_id` is NOT NULL
-- and nothing in somebody else's export names one of THIS tenant's declared
-- types. The tenant chooses it when they start the import.
-- `chk_crm_imports_subject_type` ties the two together in both directions, so
-- "a subject import with no type" and "a party import carrying one" are both
-- unrepresentable rather than discovered at row four thousand.
--
-- No foreign key on `target_subject_type_id`, and that is deliberate rather than
-- an omission. `subject_types` is soft-deleted, so a real FK would only ever
-- fire on the organisation cascade -- where `ON DELETE SET NULL` would violate
-- the CHECK above and `RESTRICT` would depend on cascade ordering between two
-- tables that both hang off `organizations`. The type is validated against this
-- organisation at preview time instead, which is where a wrong one produces a
-- sentence somebody can act on. Same reasoning as `created_party_id`, which has
-- never carried an FK either.
--
-- `created_record_id` and `matched_record_id` are the party columns renamed.
-- Additive here and backfilled here; 0282 drops the old pair once the code that
-- reads them is gone.
--
-- Authored via `generate --custom`; see 0205 for why db:generate cannot run here.

SET lock_timeout = '5s';

--> statement-breakpoint
-- A new column with a default and NOT NULL is a catalog-only change on
-- PostgreSQL 11 and later: the default is recorded rather than written into
-- every row, so this is not the table rewrite the NOT NULL rule guards against.
ALTER TABLE "crm_imports"
  ADD COLUMN IF NOT EXISTS "target_entity" text DEFAULT 'party' NOT NULL;
--> statement-breakpoint
ALTER TABLE "crm_imports" ADD COLUMN IF NOT EXISTS "target_subject_type_id" text;

--> statement-breakpoint
ALTER TABLE "crm_imports" DROP CONSTRAINT IF EXISTS "chk_crm_imports_target_entity";
--> statement-breakpoint
ALTER TABLE "crm_imports" ADD CONSTRAINT "chk_crm_imports_target_entity"
  CHECK ("target_entity" IN ('party', 'subject', 'pipeline', 'activity')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "crm_imports" VALIDATE CONSTRAINT "chk_crm_imports_target_entity";

--> statement-breakpoint
-- Set for a subject import, null for every other. Both directions, because a
-- party import carrying a subject type is as wrong as a subject import without
-- one -- it would mean the entity was changed after the plan was made.
ALTER TABLE "crm_imports" ADD CONSTRAINT "chk_crm_imports_subject_type"
  CHECK (("target_entity" = 'subject') = ("target_subject_type_id" IS NOT NULL)) NOT VALID;
--> statement-breakpoint
ALTER TABLE "crm_imports" VALIDATE CONSTRAINT "chk_crm_imports_subject_type";

--> statement-breakpoint
ALTER TABLE "crm_import_rows" ADD COLUMN IF NOT EXISTS "created_record_id" text;
--> statement-breakpoint
ALTER TABLE "crm_import_rows" ADD COLUMN IF NOT EXISTS "matched_record_id" text;

--> statement-breakpoint
-- Every row written before this migration was a party row, so the old columns
-- are exactly the new ones. Backfilled here rather than left to the reader,
-- because `chk_crm_import_rows_outcome` is re-pointed at the new column below
-- and would otherwise refuse every committed row this table already holds.
UPDATE "crm_import_rows"
  SET "created_record_id" = "created_party_id"
  WHERE "created_party_id" IS NOT NULL AND "created_record_id" IS NULL;
--> statement-breakpoint
UPDATE "crm_import_rows"
  SET "matched_record_id" = "matched_party_id"
  WHERE "matched_party_id" IS NOT NULL AND "matched_record_id" IS NULL;

--> statement-breakpoint
-- The same invariant 0280 widened, now expressed over the renamed column: a
-- committed row records what it did, so it can be undone. `error IS NOT NULL`
-- stays the one relaxation -- a row Postgres refused is marked done with its
-- error, because leaving it outstanding would have every later attempt retry
-- the same bad cell and hold the import open forever.
ALTER TABLE "crm_import_rows" DROP CONSTRAINT IF EXISTS "chk_crm_import_rows_outcome";
--> statement-breakpoint
ALTER TABLE "crm_import_rows" ADD CONSTRAINT "chk_crm_import_rows_outcome"
  CHECK (
    "committed_at" IS NULL
    OR "error" IS NOT NULL
    OR "action" IN ('skip', 'merge')
    OR ("action" = 'create' AND "created_record_id" IS NOT NULL)
    OR ("action" = 'update' AND "previous" IS NOT NULL)
    OR ("action" = 'review' AND "data_quality_finding_id" IS NOT NULL)
  ) NOT VALID;
--> statement-breakpoint
ALTER TABLE "crm_import_rows" VALIDATE CONSTRAINT "chk_crm_import_rows_outcome";

--> statement-breakpoint
-- The lookup an activities or deals import makes to find the record each row
-- belongs to.
--
-- `idx_business_parties_org_name` is on the raw column, so a file writing
-- `ACME LTD` for a party stored as `Acme Ltd` would miss it -- and every one of
-- those rows is skipped for want of an anchor, which is a whole import that
-- silently does nothing. Folded here instead of at the call site because a
-- `lower(name)` predicate cannot use the raw index at all, and the alternative
-- is walking every party in the organisation once per import.
--
-- Usable under row-level security, unlike the trigram indexes on this table:
-- the operator here is `=` on text, which is leakproof, so the planner may run
-- it before the policy predicate.
CREATE INDEX IF NOT EXISTS "idx_business_parties_org_lower_name"
  ON "business_parties" ("organization_id", lower("name"))
  WHERE "deleted_at" IS NULL;

--> statement-breakpoint
ANALYZE "business_parties";
--> statement-breakpoint
ANALYZE "crm_imports";
--> statement-breakpoint
ANALYZE "crm_import_rows";
