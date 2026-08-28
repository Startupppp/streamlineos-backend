-- 0640: helpdesk keyset cursor indexes, trigram search indexes, and search probe.
--
-- list() replaces OFFSET pagination with a (created_at DESC, id DESC) keyset cursor.
-- The probe escapes the RLS leakproof barrier: org comes from app.current_org_id() and never a
-- parameter, returns ids only, caller query still runs under RLS, EXECUTE revoked from PUBLIC.

CREATE INDEX IF NOT EXISTS "idx_helpdesk_tickets_org_created"
  ON "helpdesk_tickets" ("org_id", "created_at" DESC, "id" DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_helpdesk_tickets_org_status_created"
  ON "helpdesk_tickets" ("org_id", "status", "created_at" DESC, "id" DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_helpdesk_tickets_org_user_created"
  ON "helpdesk_tickets" ("org_id", "user_id", "created_at" DESC, "id" DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_helpdesk_tickets_org_assignee_created"
  ON "helpdesk_tickets" ("org_id", "assignee_id", "created_at" DESC, "id" DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_helpdesk_tickets_title_trgm"
  ON "helpdesk_tickets" USING gin ("title" gin_trgm_ops);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_helpdesk_tickets_description_trgm"
  ON "helpdesk_tickets" USING gin ("description" gin_trgm_ops);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.search_helpdesk_ticket_ids(p_q text, p_limit integer)
RETURNS SETOF integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
  SELECT t.id
  FROM public.helpdesk_tickets t
  WHERE t.org_id = app.current_org_id()
    AND (
      t.title ILIKE '%' || p_q || '%'
      OR t.description ILIKE '%' || p_q || '%'
    )
  LIMIT p_limit
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.search_helpdesk_ticket_ids(text, integer) FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION app.search_helpdesk_ticket_ids(text, integer) TO streamline_app;
--> statement-breakpoint

DROP INDEX IF EXISTS "idx_helpdesk_tickets_org_status";
--> statement-breakpoint

DROP INDEX IF EXISTS "idx_helpdesk_tickets_org_user";
--> statement-breakpoint

DROP INDEX IF EXISTS "idx_helpdesk_tickets_org_assignee";
