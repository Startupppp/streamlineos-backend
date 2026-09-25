-- 1220 — HRM-15: the organization's business date, in SQL
--
-- Reporting lines start on the organization's business date (`orgBusinessDate`, the org's
-- timezone), but every current-line reader compared them with CURRENT_DATE — the session date,
-- UTC for the app role. Between the org's midnight and UTC midnight a line written "today" was
-- invisible to approval routing, /me/team and the org chart.
--
-- `organizations.timezone` is not validated on write, and `AT TIME ZONE` raises on an unknown
-- zone, so the lookup catches that and answers the session date instead of failing the read —
-- the same fallback `orgBusinessDate` takes in TypeScript. Callers wrap it in a scalar subquery
-- so it is evaluated once per statement.
--
-- Rollback: migrations/rollback/1220_app_org_business_date.down.sql
SET lock_timeout = '5s';
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.org_business_date(p_org_id text)
RETURNS date
LANGUAGE plpgsql
STABLE
PARALLEL SAFE
AS $$
DECLARE
  zone text;
BEGIN
  SELECT o.timezone INTO zone FROM public.organizations o WHERE o.id = p_org_id;
  IF zone IS NULL THEN
    RETURN CURRENT_DATE;
  END IF;
  RETURN (now() AT TIME ZONE zone)::date;
EXCEPTION
  WHEN invalid_parameter_value THEN
    RETURN CURRENT_DATE;
END;
$$;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION app.org_business_date(text) TO streamline_app;
