SET statement_timeout = 0;

-- =============================================================================
-- 0371 — drop the per-user `users.role` label
-- =============================================================================
-- `users.role` was a GLOBAL per-user label, but a person can belong to several
-- organizations with a different standing in each. The per-org label already
-- lives on `organization_members.role`, and permissions come from
-- `role_assignments` — neither of which this column ever influenced.
--
-- It did still drive two authorization paths, both migrated first:
--   * KB space/article grants matched `kb_*.role` against `users.role`. After
--     the six-role collapse that made a grant to "HR" match NOBODY and a grant
--     to "MEMBER" match EVERYONE. They now match the caller's real RBAC role
--     slugs. Verified 0 rows carried a role-based KB grant, so nothing changed
--     hands.
--   * HR policy scopes of type "role" compared against it; they now compare
--     against RBAC role slugs. Verified 0 such scope rows exist.
--
-- The session claim now reads `organization_members.role`, which also resolves
-- a pre-existing split where PAT auth already used the membership label while
-- JWT auth used this one — the same person could present two different roles.
-- =============================================================================

DO $$
DECLARE
  kb_space_grants integer;
  kb_article_grants integer;
  policy_scopes integer;
BEGIN
  SELECT count(*) INTO kb_space_grants   FROM kb_space_members         WHERE role IS NOT NULL;
  SELECT count(*) INTO kb_article_grants FROM kb_article_restrictions  WHERE role IS NOT NULL;
  SELECT count(*) INTO policy_scopes     FROM hr_policy_scopes         WHERE scope_type = 'role';

  -- These rows used to be matched against users.role. They now match RBAC role
  -- slugs, so any legacy value would silently stop granting. Refuse to drop the
  -- column while one exists rather than change who can see what.
  IF kb_space_grants > 0 OR kb_article_grants > 0 OR policy_scopes > 0 THEN
    RAISE EXCEPTION
      '0371: legacy role-based grants still present (kb_space=%, kb_article=%, hr_policy=%) — migrate them to RBAC role slugs first',
      kb_space_grants, kb_article_grants, policy_scopes;
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "users" DROP COLUMN IF EXISTS "role";
