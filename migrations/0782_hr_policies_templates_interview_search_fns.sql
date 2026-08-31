-- 0782: SECURITY DEFINER search functions + trgm indexes for hr_policies,
-- hr_templates and interview_questions.
--
-- Same escape as 0781 (SECURITY DEFINER + BYPASSRLS owner). See 0781 for the
-- full safety condition list.
--
-- Also adds a lower(skill_name) functional index on employee_skills so the
-- case-insensitive equality join in hr_analytics_plus can use it instead of
-- ILIKE (an ILIKE join is never leakproof and cannot use a trgm index when
-- the right-hand side is a column rather than a literal).

SET lock_timeout = '5s';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_hr_policies_name_trgm"
  ON "hr_policies" USING gin ("name" gin_trgm_ops);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_hr_policies_description_trgm"
  ON "hr_policies" USING gin ("description" gin_trgm_ops);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.search_hr_policy_ids(p_q text, p_limit integer)
RETURNS SETOF integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
  SELECT id
  FROM public.hr_policies
  WHERE org_id = app.current_org_id()
    AND deleted_at IS NULL
    AND (
      name        ILIKE '%' || p_q || '%'
      OR description ILIKE '%' || p_q || '%'
    )
  LIMIT p_limit
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.search_hr_policy_ids(text, integer) FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION app.search_hr_policy_ids(text, integer) TO streamline_app;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_hr_templates_name_trgm"
  ON "hr_templates" USING gin ("name" gin_trgm_ops);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_hr_templates_description_trgm"
  ON "hr_templates" USING gin ("description" gin_trgm_ops);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.search_hr_template_ids(p_q text, p_limit integer)
RETURNS SETOF integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
  SELECT id
  FROM public.hr_templates
  WHERE org_id = app.current_org_id()
    AND deleted_at IS NULL
    AND (
      name        ILIKE '%' || p_q || '%'
      OR description ILIKE '%' || p_q || '%'
    )
  LIMIT p_limit
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.search_hr_template_ids(text, integer) FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION app.search_hr_template_ids(text, integer) TO streamline_app;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_interview_questions_question_trgm"
  ON "interview_questions" USING gin ("question" gin_trgm_ops);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.search_hr_interview_question_ids(p_q text, p_limit integer)
RETURNS SETOF integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
  SELECT id
  FROM public.interview_questions
  WHERE org_id = app.current_org_id()
    AND is_active = true
    AND question ILIKE '%' || p_q || '%'
  LIMIT p_limit
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.search_hr_interview_question_ids(text, integer) FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION app.search_hr_interview_question_ids(text, integer) TO streamline_app;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_employee_skills_lower_name"
  ON "employee_skills" (lower(skill_name));
