-- 0430: gap-free ticket number allocation via a per-project counter row.
--
-- Six call sites allocated with COALESCE(MAX(ticket_number),0)+1 and only ONE held
-- pg_advisory_xact_lock, so concurrent creates through the other five could collide on
-- uniq_tickets_project_number. This is a correctness fix, not a speed one: the old MAX was an
-- Index Scan Backward (4 buffers / 0.052ms) and the counter UPDATE is 0.087ms.
-- It also drops a lock taken in Postgres' single global advisory namespace.
--
-- Numbers are monotonic, not gap-free across rollbacks: an aborted transaction leaves its number
-- unused, which is correct — PROJ-123 is a durable reference and must never be reissued.
CREATE TABLE IF NOT EXISTS "project_ticket_counters" (
  "org_id"             text    NOT NULL,
  "project_id"         integer NOT NULL,
  "next_ticket_number" bigint  NOT NULL DEFAULT 1,
  "updated_at"         timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "project_ticket_counters_pkey" PRIMARY KEY ("org_id", "project_id")
);
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "project_ticket_counters"
    ADD CONSTRAINT "fk_project_ticket_counters_project"
    FOREIGN KEY ("org_id", "project_id") REFERENCES "public"."projects"("org_id", "id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

-- Backfill from the current high-water mark so no existing number is ever reissued.
INSERT INTO "project_ticket_counters" ("org_id", "project_id", "next_ticket_number")
SELECT p.org_id, p.id, COALESCE(MAX(t.ticket_number), 0) + 1
FROM projects p
LEFT JOIN tickets t ON t.project_id = p.id AND t.org_id = p.org_id
GROUP BY p.org_id, p.id
ON CONFLICT ("org_id", "project_id") DO NOTHING;
--> statement-breakpoint

ALTER TABLE "project_ticket_counters" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "project_ticket_counters";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "project_ticket_counters"
  FOR ALL USING (org_id = app.current_org_id()) WITH CHECK (org_id = app.current_org_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "project_ticket_counters" TO streamline_app;
