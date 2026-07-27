SET statement_timeout = 0;

-- =============================================================================
-- 0329 — org-owner exactly-one constraint
-- =============================================================================
-- Preconditions:
--   • 0310 (owner_membership_id column, bootstrap DO-block)
--   • 0311 (uniq_org_members_org_id_key constraint + fk_organizations_owner_membership)
--   • 0326 (owner_membership_id NOT NULL)
--
-- After 0326 each org has:
--   (a) organizations.owner_membership_id NOT NULL  → at-least-one-owner pointer
--   (b) fk_organizations_owner_membership (deferred) → pointer references a real member
--                                                       in the SAME org
-- This migration adds:
--   (c) partial unique index on organization_members(org_id) WHERE is_owner = TRUE
--       → at most one is_owner = TRUE row per org
--
-- (a) + (b) + (c) together enforce EXACTLY ONE owner per organization.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- VERIFY (run before applying; both queries must return zero rows)
-- -----------------------------------------------------------------------------
--
-- Orgs with more than one is_owner = TRUE row  (violate at-most-one):
--
--   SELECT org_id, COUNT(*) AS owner_count
--   FROM   organization_members
--   WHERE  is_owner = TRUE
--   GROUP  BY org_id
--   HAVING COUNT(*) > 1;
--
-- Orgs whose owner pointer references a member that no longer has is_owner = TRUE
-- (structural drift between the pointer and the flag):
--
--   SELECT o.id AS org_id,
--          o.owner_membership_id,
--          m.is_owner
--   FROM   organizations o
--   JOIN   organization_members m
--          ON m.id = o.owner_membership_id
--          AND m.org_id = o.id
--   WHERE  m.is_owner IS DISTINCT FROM TRUE;
-- -----------------------------------------------------------------------------


-- Partial unique index: at most ONE is_owner = TRUE per org.
-- Idempotent (IF NOT EXISTS).  Named to match the project's index-naming pattern.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_org_members_single_owner
    ON organization_members (org_id)
    WHERE is_owner = TRUE;
