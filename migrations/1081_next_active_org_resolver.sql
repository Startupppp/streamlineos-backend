-- 1081: batch the next-active-org lookup that org archive and purge run per member.
--
-- OrgLifecycleService.resolveReplacementOrgIds opens one withIdentity transaction PER MEMBER and
-- runs findNextActiveOrgId inside it, so archiving an organisation costs one transaction per person
-- in it. It could not be batched in SQL because the wanted rows are in organisations the caller is
-- not in: policy tenant_isolation on organization_members (migration 0383) is
--   USING (org_id = app.current_org_id_or_null() OR user_id = app.current_user_id_or_null())
-- The org arm cannot reach another organisation's rows, and the identity arm admits exactly one
-- principal because app.user_id is a single text GUC - so "set the GUC once, then one statement"
-- is not expressible for a SET of users.
--
-- SAFETY. This does NOT match the app.search_ticket_ids template in backend/CLAUDE.md section 3,
-- because that template requires the answer to stay inside app.current_org_id() and this lookup is
-- inherently cross-organisation. The argument is therefore made here rather than borrowed:
--
--   1. The excluded organisation is NOT a parameter. It is app.current_org_id(), which raises 42501
--      when the GUC is absent, so the function fails closed exactly like the template does.
--   2. The subject set is fenced to the caller's own organisation. p_user_ids is intersected with
--      the ACTIVE members of app.current_org_id(), so a caller can only ask about people they
--      already administer. Passing an arbitrary user id returns no row rather than an answer.
--   3. It returns organisation ids only - no member row, no name, no status, no join date.
--   4. EXECUTE is revoked from PUBLIC and granted only to the application role.
--
-- DISCLOSURE, stated plainly: an administrator archiving an organisation learns which other
-- organisation each departing member lands in, which reveals that the membership exists. That is
-- NOT a new disclosure. findNextActiveOrgId already computes exactly this value for exactly these
-- users today, one statement at a time, and hands it to the same caller. This migration changes the
-- statement count, not the data anybody can see.

-- `next_org_id` is text, not uuid: organizations.id and organization_members.org_id are both
-- `text` on this schema, and so is app.current_org_id(). A uuid return column compiled fine and
-- failed at apply time with "return type mismatch in function declared to return record"; the
-- cold replay caught it, no static check could have.
SET lock_timeout = '5s';
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.next_active_org_ids(p_user_ids text[])
RETURNS TABLE (user_id text, next_org_id text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
  SELECT subject.user_id, next_org.org_id
  FROM (
    SELECT om.user_id
    FROM public.organization_members om
    WHERE om.org_id = app.current_org_id()
      AND om.user_id = ANY(p_user_ids)
      AND om.status = 'ACTIVE'
  ) AS subject
  LEFT JOIN LATERAL (
    SELECT om.org_id
    FROM public.organization_members om
    INNER JOIN public.organizations o ON o.id = om.org_id
    WHERE om.user_id = subject.user_id
      AND om.status = 'ACTIVE'
      AND o.status = 'ACTIVE'
      AND o.deleted_at IS NULL
      AND om.org_id <> app.current_org_id()
    ORDER BY om.joined_at DESC
    LIMIT 1
  ) AS next_org ON TRUE
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.next_active_org_ids(text[]) FROM PUBLIC;
--> statement-breakpoint

DO $$
DECLARE
  app_role text := coalesce(current_setting('app.bootstrap_role', true), 'streamline_app');
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION app.next_active_org_ids(text[]) TO %I', app_role);
  END IF;
END $$;
--> statement-breakpoint

COMMENT ON FUNCTION app.next_active_org_ids(text[]) IS
  'Returns the most recently joined still-active organisation for each supplied user, excluding app.current_org_id(). Fenced to ACTIVE members of the current organisation, so it answers only about people the caller already administers, and returns organisation ids only. Replaces the per-member withIdentity transaction in OrgLifecycleService.resolveReplacementOrgIds.';
