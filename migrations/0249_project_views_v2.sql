-- Migration 0249: project_views v2 (personal/shared views, workspace scope, display options)
-- All ALTERs are additive and backward-compatible (nullable FK, NOT NULL with DEFAULT so existing rows get values).

-- 1. Make project_id nullable to support workspace-level views (scope='workspace').
ALTER TABLE "project_views"
  ALTER COLUMN "project_id" DROP NOT NULL;

-- 2. Add visibility column (NOT NULL DEFAULT 'shared').
--    DEFAULT 'shared' ensures every existing row remains visible to all members —
--    exactly the current behavior before this migration.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'project_views' AND column_name = 'visibility'
  ) THEN
    ALTER TABLE "project_views"
      ADD COLUMN "visibility" text NOT NULL DEFAULT 'shared';
  END IF;
END $$;

-- 3. Add display_options column (NOT NULL DEFAULT '{}').
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'project_views' AND column_name = 'display_options'
  ) THEN
    ALTER TABLE "project_views"
      ADD COLUMN "display_options" jsonb NOT NULL DEFAULT '{}';
  END IF;
END $$;

-- 4. Add scope column (NOT NULL DEFAULT 'project').
--    Existing rows are project-scoped by definition.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'project_views' AND column_name = 'scope'
  ) THEN
    ALTER TABLE "project_views"
      ADD COLUMN "scope" text NOT NULL DEFAULT 'project';
  END IF;
END $$;

-- 5. Composite index on (org_id, scope) for workspace-level view listing.
CREATE INDEX IF NOT EXISTS "idx_project_views_org_scope"
  ON "project_views" ("org_id", "scope");

-- 6. Task 3: composite index on tickets (org_id, project_id, status) for cross-project queries.
CREATE INDEX IF NOT EXISTS "idx_tickets_org_project_status"
  ON "tickets" ("org_id", "project_id", "status");
