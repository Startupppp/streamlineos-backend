-- 0430: SCH-017 read/write cutover.
--
-- 0429 added `broadcast_audience_targets` but left `broadcasts.audience` (JSONB) as the
-- only path anything actually read or wrote. This migration completes the expand half:
-- the audience TYPE becomes a real column, the audience IDS move into the junction, and
-- both are backfilled from the existing JSONB so the new read path returns the same
-- recipients for rows created before the cutover.
--
-- The JSONB column is deliberately still here and still written. Dropping it is the
-- contract step, and it only becomes safe once the junction has been the read path in
-- production long enough to trust — a broadcast resolving to the wrong audience is not
-- a defect anyone notices quietly.

SET statement_timeout = 0;
SET lock_timeout = '5s';

DO $$ BEGIN
  CREATE TYPE "broadcast_audience_type" AS ENUM ('all','roles','departments','users');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

ALTER TABLE "broadcasts"
  ADD COLUMN IF NOT EXISTS "audience_type" "broadcast_audience_type" NOT NULL DEFAULT 'all';
--> statement-breakpoint

-- Backfill the discriminator. An unrecognised or absent type falls back to 'all', which
-- matches how resolveRecipients already behaved (its final branch is the catch-all).
UPDATE "broadcasts"
SET "audience_type" = CASE "audience"->>'type'
    WHEN 'roles' THEN 'roles'::"broadcast_audience_type"
    WHEN 'departments' THEN 'departments'::"broadcast_audience_type"
    WHEN 'users' THEN 'users'::"broadcast_audience_type"
    ELSE 'all'::"broadcast_audience_type"
  END
WHERE "audience" IS NOT NULL;
--> statement-breakpoint

-- Backfill the ids. jsonb_array_elements_text over each typed array; ON CONFLICT keeps
-- the migration re-runnable.
INSERT INTO "broadcast_audience_targets" ("org_id","broadcast_id","kind","target_id")
SELECT b."org_id", b."id", 'ROLE'::"broadcast_audience_kind", t.value
FROM "broadcasts" b,
     LATERAL jsonb_array_elements_text(b."audience"->'roleIds') AS t(value)
WHERE jsonb_typeof(b."audience"->'roleIds') = 'array' AND t.value <> ''
ON CONFLICT ("broadcast_id","kind","target_id") DO NOTHING;
--> statement-breakpoint

INSERT INTO "broadcast_audience_targets" ("org_id","broadcast_id","kind","target_id")
SELECT b."org_id", b."id", 'DEPARTMENT'::"broadcast_audience_kind", t.value
FROM "broadcasts" b,
     LATERAL jsonb_array_elements_text(b."audience"->'departmentIds') AS t(value)
WHERE jsonb_typeof(b."audience"->'departmentIds') = 'array' AND t.value <> ''
ON CONFLICT ("broadcast_id","kind","target_id") DO NOTHING;
--> statement-breakpoint

INSERT INTO "broadcast_audience_targets" ("org_id","broadcast_id","kind","target_id")
SELECT b."org_id", b."id", 'USER'::"broadcast_audience_kind", t.value
FROM "broadcasts" b,
     LATERAL jsonb_array_elements_text(b."audience"->'userIds') AS t(value)
WHERE jsonb_typeof(b."audience"->'userIds') = 'array' AND t.value <> ''
ON CONFLICT ("broadcast_id","kind","target_id") DO NOTHING;
