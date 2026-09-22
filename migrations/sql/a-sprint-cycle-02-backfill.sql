-- Phase 2 / Workstream A / P0 #6 -- Sprint-Cycle consolidation, phase 02 (BACKFILL).
-- Data only. Idempotent: re-running produces byte-identical tables. Order-independent: every
-- statement is set-based and every tie-break names a full key. Rollback: a-sprint-cycle-02-backfill-rollback.sql
-- Conflict-resolution rules and their justification: docs/build-module/phase-2/06-sprint-cycle-consolidation.md

SET lock_timeout = '5s';
--> statement-breakpoint

INSERT INTO "build"."sprint_cycle_migration_map" ("org_id", "sprint_id", "cycle_id")
SELECT c."org_id", c."legacy_sprint_id", c."id"
  FROM "build"."cycles" c
 WHERE c."legacy_sprint_id" IS NOT NULL
ON CONFLICT ("org_id", "sprint_id") DO NOTHING;
--> statement-breakpoint

WITH src AS (
  SELECT
    s."org_id"                                          AS org_id,
    s."id"                                              AS sprint_id,
    s."project_id"                                      AS project_id,
    s."name"                                            AS name,
    s."goal"                                            AS goal,
    s."start_date"::date                                AS start_date,
    s."end_date"::date                                  AS end_date,
    CASE upper(btrim(coalesce(s."status", '')))
      WHEN 'PLANNED'   THEN 'draft'
      WHEN 'ACTIVE'    THEN 'active'
      WHEN 'COMPLETED' THEN 'completed'
      ELSE 'draft'
    END                                                 AS status_text,
    s."deleted_at"                                      AS deleted_at,
    s."created_at"                                      AS created_at,
    s."updated_at"                                      AS updated_at,
    COALESCE(
      (SELECT om."user_id" FROM "organization_members" om
        WHERE om."org_id" = s."org_id" AND om."id" = p."manager_membership_id"),
      (SELECT om."user_id" FROM "organization_members" om
        WHERE om."org_id" = s."org_id" AND om."id" = o."owner_membership_id"),
      (SELECT min(om2."user_id") FROM "organization_members" om2
        WHERE om2."org_id" = s."org_id")
    )                                                   AS created_by
  FROM "build"."sprints" s
  JOIN "build"."projects" p ON p."org_id" = s."org_id" AND p."id" = s."project_id"
  JOIN "organizations" o ON o."id" = s."org_id"
  WHERE NOT EXISTS (
    SELECT 1 FROM "build"."cycles" c
     WHERE c."org_id" = s."org_id" AND c."legacy_sprint_id" = s."id"
  )
),
ins AS (
  INSERT INTO "build"."cycles" (
    "org_id", "project_id", "name", "description", "goal", "status",
    "start_date", "end_date", "created_by", "created_at", "updated_at",
    "deleted_at", "legacy_sprint_id"
  )
  SELECT
    src.org_id, src.project_id, src.name, NULL, src.goal, src.status_text::"cycle_status",
    src.start_date, src.end_date, src.created_by, src.created_at, src.updated_at,
    src.deleted_at, src.sprint_id
  FROM src
  WHERE src.created_by IS NOT NULL
  RETURNING "org_id" AS org_id, "id" AS cycle_id, "legacy_sprint_id" AS legacy_sprint_id
)
INSERT INTO "build"."sprint_cycle_migration_map" ("org_id", "sprint_id", "cycle_id")
SELECT ins.org_id, ins.legacy_sprint_id, ins.cycle_id FROM ins
ON CONFLICT ("org_id", "sprint_id") DO NOTHING;
--> statement-breakpoint

INSERT INTO "build"."sprint_binding_archive"
  ("org_id", "source_table", "source_id", "sprint_id", "cycle_id", "resolution")
SELECT
  t."org_id", 'build.tickets', t."id", t."sprint_id", t."cycle_id",
  CASE
    WHEN m."cycle_id" IS NULL        THEN 'orphan_sprint'
    WHEN t."cycle_id" IS NULL        THEN 'mapped'
    WHEN t."cycle_id" = m."cycle_id" THEN 'agreed'
    ELSE 'cycle_wins'
  END
FROM "build"."tickets" t
LEFT JOIN "build"."sprint_cycle_migration_map" m
       ON m."org_id" = t."org_id" AND m."sprint_id" = t."sprint_id"
WHERE t."sprint_id" IS NOT NULL
ON CONFLICT ("source_table", "org_id", "source_id") DO NOTHING;
--> statement-breakpoint

INSERT INTO "build"."sprint_binding_archive"
  ("org_id", "source_table", "source_id", "sprint_id", "cycle_id", "resolution")
SELECT
  x."org_id", x."source_table", x."source_id", x."sprint_id", x."cycle_id",
  CASE
    WHEN x."mapped_cycle_id" IS NULL        THEN 'orphan_sprint'
    WHEN x."cycle_id" IS NULL               THEN 'mapped'
    WHEN x."cycle_id" = x."mapped_cycle_id" THEN 'agreed'
    ELSE 'cycle_wins'
  END
FROM (
  SELECT pm."org_id", 'build.project_meetings' AS "source_table", pm."id"::bigint AS "source_id",
         pm."sprint_id", pm."cycle_id",
         (SELECT m."cycle_id" FROM "build"."sprint_cycle_migration_map" m
           WHERE m."org_id" = pm."org_id" AND m."sprint_id" = pm."sprint_id") AS "mapped_cycle_id"
    FROM "build"."project_meetings" pm WHERE pm."sprint_id" IS NOT NULL
  UNION ALL
  SELECT tr."org_id", 'build.test_runs', tr."id"::bigint, tr."sprint_id", tr."cycle_id",
         (SELECT m."cycle_id" FROM "build"."sprint_cycle_migration_map" m
           WHERE m."org_id" = tr."org_id" AND m."sprint_id" = tr."sprint_id")
    FROM "build"."test_runs" tr WHERE tr."sprint_id" IS NOT NULL
  UNION ALL
  SELECT e."org_id", 'build_events.sprint_scope_events', e."id"::bigint, e."sprint_id", e."cycle_id",
         (SELECT m."cycle_id" FROM "build"."sprint_cycle_migration_map" m
           WHERE m."org_id" = e."org_id" AND m."sprint_id" = e."sprint_id")
    FROM "build_events"."sprint_scope_events" e
) x
ON CONFLICT ("source_table", "org_id", "source_id") DO NOTHING;
--> statement-breakpoint

UPDATE "build"."tickets" t
   SET "cycle_id" = m."cycle_id"
  FROM "build"."sprint_cycle_migration_map" m
 WHERE m."org_id" = t."org_id"
   AND m."sprint_id" = t."sprint_id"
   AND t."sprint_id" IS NOT NULL
   AND t."cycle_id" IS NULL;
--> statement-breakpoint

UPDATE "build"."project_meetings" pm
   SET "cycle_id" = m."cycle_id"
  FROM "build"."sprint_cycle_migration_map" m
 WHERE m."org_id" = pm."org_id"
   AND m."sprint_id" = pm."sprint_id"
   AND pm."sprint_id" IS NOT NULL
   AND pm."cycle_id" IS NULL;
--> statement-breakpoint

UPDATE "build"."test_runs" tr
   SET "cycle_id" = m."cycle_id"
  FROM "build"."sprint_cycle_migration_map" m
 WHERE m."org_id" = tr."org_id"
   AND m."sprint_id" = tr."sprint_id"
   AND tr."sprint_id" IS NOT NULL
   AND tr."cycle_id" IS NULL;
--> statement-breakpoint

UPDATE "build_events"."sprint_scope_events" e
   SET "cycle_id" = m."cycle_id"
  FROM "build"."sprint_cycle_migration_map" m
 WHERE m."org_id" = e."org_id"
   AND m."sprint_id" = e."sprint_id"
   AND e."cycle_id" IS NULL;
--> statement-breakpoint

DO $$
DECLARE
  unmapped_sprints bigint;
  unbound_events bigint;
BEGIN
  SELECT count(*) INTO unmapped_sprints
    FROM "build"."sprints" s
   WHERE NOT EXISTS (
     SELECT 1 FROM "build"."sprint_cycle_migration_map" m
      WHERE m."org_id" = s."org_id" AND m."sprint_id" = s."id"
   );
  IF unmapped_sprints > 0 THEN
    RAISE EXCEPTION 'sprint-cycle backfill incomplete: % sprint row(s) have no cycle counterpart', unmapped_sprints;
  END IF;

  SELECT count(*) INTO unbound_events
    FROM "build_events"."sprint_scope_events" e WHERE e."cycle_id" IS NULL;
  IF unbound_events > 0 THEN
    RAISE EXCEPTION 'sprint-cycle backfill incomplete: % sprint_scope_events row(s) have a null cycle_id', unbound_events;
  END IF;
END $$;
