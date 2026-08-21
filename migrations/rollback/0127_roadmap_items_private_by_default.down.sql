-- Rollback for 0127_roadmap_items_private_by_default
-- Reverses: roadmap_items.is_public DEFAULT true → false
--
-- Data note: existing rows already have is_public = false (the new default).
-- This rollback restores the DEFAULT only; it does NOT flip existing rows.
-- If you need to restore rows written after the migration to true, you would
-- need a separate data-fix (out of scope for a schema rollback).

SET lock_timeout = '5s';

ALTER TABLE "roadmap_items" ALTER COLUMN "is_public" SET DEFAULT true;
