SET statement_timeout = 0;
SET lock_timeout = '5s';

-- 0386 — resolve the org id for a public survey response session, same shape
-- as 0385's intake resolver.
--
-- PATCH/POST /public/surveys/:collectorToken/session/:sessionId identifies the
-- response session by its serial (guessable) id alone — the collector token in
-- the URL is not re-validated against it. That is the app's existing, pre-RLS
-- design: the session id is handed back once by startSession() (itself reached
-- only via a real collector token) and trusted afterward, not something this
-- migration should change. 0378 put survey_response_sessions behind
-- `org_id = app.current_org_id()`, so that lookup now 42501s.
--
-- A `survey_response_sessions` policy arm keyed on `id` would let anyone
-- enumerate every tenant's response rows (answers, scores, participant links)
-- by incrementing a small integer — a materially bigger disclosure than the
-- one column this endpoint actually needs. The SECURITY DEFINER resolver keeps
-- the fix as narrow as 0385's.

CREATE OR REPLACE FUNCTION app.resolve_survey_session_org_id(p_session_id integer) RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT org_id FROM survey_response_sessions WHERE id = p_session_id;
$$;
--> statement-breakpoint

COMMENT ON FUNCTION app.resolve_survey_session_org_id(integer) IS
  'Returns only the org_id for a survey response session, bypassing RLS for that single column so a public, token-less session update can resolve its tenant. Never expose any other session column through this path.';
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.resolve_survey_session_org_id(integer) FROM PUBLIC;
--> statement-breakpoint

DO $$
DECLARE
  app_role text := coalesce(current_setting('app.bootstrap_role', true), 'streamline_app');
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION app.resolve_survey_session_org_id(integer) TO %I', app_role);
  END IF;
END $$;
