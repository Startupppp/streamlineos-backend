SET statement_timeout = 0;
SET lock_timeout = '5s';

-- 0384 — let a @Public() token flow read the one row its bearer token names.
--
-- Same ordering problem 0383 solved for sign-in, one layer out. A public token
-- endpoint (invitation accept, offer acceptance, e-sign, public forms) has no
-- authenticated user and therefore no tenant GUC, but the row the token points
-- at is HOW the org is chosen. 0378 gave every entry-point table the strict
-- predicate `org_id = app.current_org_id()`, so the lookup that must run first
-- became the one lookup that could not run at all — these endpoints fail on
-- their first SELECT, before any write.
--
-- The token is the bearer secret, so it is a sufficient security boundary for
-- exactly one row. `app.public_token` is set only by withPublicToken()
-- (src/common/tenant/with-public-token.ts), which is used ONLY to resolve the
-- org id; every query after that belongs in runInTenantTransaction().
--
-- The accessor is NON-raising, matching 0381/0383: an RLS USING predicate is
-- evaluated per row before the query's own WHERE, so a raising arm would abort
-- the scan the moment it crossed another tenant's row. With no GUC set the arm
-- is NULL, no row qualifies, and the reader sees nothing.
--
-- WITH CHECK stays strict on every table below: writing still demands a real
-- tenant context, so a token can be used to FIND an org, never to write into
-- one. Accepting an invitation satisfies that by re-entering through
-- runInTenantTransaction() with the org id the lookup returned.

CREATE OR REPLACE FUNCTION app.current_public_token_or_null() RETURNS text
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  RETURN nullif(current_setting('app.public_token', true), '');
END;
$$;
--> statement-breakpoint

COMMENT ON FUNCTION app.current_public_token_or_null() IS
  'Public bearer token for the current transaction, or NULL when unset. Set by withPublicToken() so a @Public() endpoint can resolve the org id from the single row its token names, before any tenant context exists. Never raises: an RLS USING arm that raises aborts the whole scan.';
--> statement-breakpoint

DO $$
DECLARE
  app_role text := coalesce(current_setting('app.bootstrap_role', true), 'streamline_app');
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION app.current_public_token_or_null() TO %I', app_role);
  END IF;
END $$;
--> statement-breakpoint

-- Only HIGH-ENTROPY secret columns are listed. An arm keyed on a guessable
-- identifier (a serial id) would let anyone read any tenant's row by counting,
-- which is why csat_surveys.id and survey_response_sessions.id are deliberately
-- absent — those endpoints need an unguessable token before they can be fixed.
--
-- Driven from pg_catalog and skipped with a NOTICE when a table or column does
-- not exist, so a mis-named pair fails visibly here instead of silently
-- shipping a policy that admits nothing.

DO $$
DECLARE
  pair record;
  tenant_col text;
  applied int := 0;
  skipped int := 0;
BEGIN
  FOR pair IN
    SELECT * FROM (VALUES
      ('invitations',            'token_hash'),
      ('portal_invitations',     'token_hash'),
      ('sign_public_forms',      'slug'),
      ('sign_recipients',        'signing_token_hash'),
      ('survey_collectors',      'token'),
      ('survey_live_sessions',   'session_code'),
      ('support_csat_requests',  'token'),
      ('kb_pages',               'public_token'),
      ('feedbucket_widgets',     'public_key'),
      ('interview_booking_links','token'),
      ('project_whiteboards',    'share_token'),
      ('candidate_applications', 'tracking_token'),
      ('candidate_offers',       'acceptance_token'),
      ('external_referrers',     'referral_token'),
      ('recruitment_vendors',    'portal_token'),
      ('project_forms',          'public_token'),
      ('nps_surveys',            'public_token'),
      ('web_lead_forms',         'public_token'),
      ('agent_tokens',           'token_hash')
    ) AS t(table_name, token_column)
  LOOP
    SELECT a.attname INTO tenant_col
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    WHERE n.nspname = 'public'
      AND c.relname = pair.table_name
      AND c.relkind = 'r'
      AND a.attname IN ('org_id', 'organization_id')
      AND format_type(a.atttypid, NULL) = 'text'
    ORDER BY (a.attname = 'org_id') DESC
    LIMIT 1;

    IF tenant_col IS NULL THEN
      RAISE NOTICE 'skip %: no text org_id/organization_id column', pair.table_name;
      skipped := skipped + 1;
      CONTINUE;
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      WHERE n.nspname = 'public'
        AND c.relname = pair.table_name
        AND a.attname = pair.token_column
    ) THEN
      RAISE NOTICE 'skip %.%: token column does not exist', pair.table_name, pair.token_column;
      skipped := skipped + 1;
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', pair.table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', pair.table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I FOR ALL '
      'USING (%I = app.current_org_id_or_null() OR %I::text = app.current_public_token_or_null()) '
      'WITH CHECK (%I = app.current_org_id())',
      pair.table_name, tenant_col, pair.token_column, tenant_col
    );
    applied := applied + 1;
  END LOOP;

  RAISE NOTICE 'public-token read arm applied to % table(s), % skipped', applied, skipped;
END $$;
--> statement-breakpoint

-- job_postings is a different shape: /careers has no org param at all —
-- CareersService.listOpenJobs() already lists every org's OPEN postings on one
-- global unauthenticated board, by product design, with no token in play.
-- `id` is a serial (guessable), so admitting it as a public-token column the
-- way the DO block above does would be new cross-tenant enumeration surface —
-- but a status predicate is not: it grants nothing the endpoint doesn't already
-- disclose on purpose. Non-OPEN postings (draft/closed) stay tenant-isolated.

DROP POLICY IF EXISTS tenant_isolation ON public.job_postings;
--> statement-breakpoint

CREATE POLICY tenant_isolation ON public.job_postings
  FOR ALL
  USING (
    org_id = app.current_org_id_or_null()
    OR status = 'OPEN'
  )
  WITH CHECK (org_id = app.current_org_id());
