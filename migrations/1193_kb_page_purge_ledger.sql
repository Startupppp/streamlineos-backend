SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('public.kb_pages') IS NULL THEN
    RAISE EXCEPTION '1193 precondition: public.kb_pages is absent — this is not a Knowledge database';
  END IF;
  IF to_regclass('public.kb_page_purge_ledger') IS NOT NULL THEN
    RAISE EXCEPTION '1193 precondition: public.kb_page_purge_ledger already exists — this migration has run';
  END IF;
END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "public"."kb_page_purge_ledger" (
  "id" uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  "org_id" text NOT NULL,
  "page_id" integer NOT NULL,
  "store" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "completed_at" timestamp with time zone,
  "failed_reason" text,
  "attempt_count" integer NOT NULL DEFAULT 0,
  CONSTRAINT "chk_kb_purge_ledger_store" CHECK (
    "store" IN ('visits', 'favorites', 'source_links', 'page_rows', 'blobs')
  ),
  CONSTRAINT "chk_kb_purge_ledger_status" CHECK (
    "status" IN ('pending', 'completed', 'failed')
  )
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_kb_purge_ledger_org_page_store"
  ON "public"."kb_page_purge_ledger" ("org_id", "page_id", "store");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_kb_purge_ledger_org_status_created"
  ON "public"."kb_page_purge_ledger" ("org_id", "status", "created_at");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_kb_purge_ledger_pending_global"
  ON "public"."kb_page_purge_ledger" ("status", "created_at")
  WHERE "status" = 'pending';
--> statement-breakpoint

ALTER TABLE "public"."kb_page_purge_ledger"
  ADD CONSTRAINT "kb_page_purge_ledger_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "public"."organizations" ("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint

ALTER TABLE "public"."kb_page_purge_ledger"
  VALIDATE CONSTRAINT "kb_page_purge_ledger_org_id_organizations_id_fk";
--> statement-breakpoint

ALTER TABLE "public"."kb_page_purge_ledger" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

DROP POLICY IF EXISTS tenant_isolation ON "public"."kb_page_purge_ledger";
--> statement-breakpoint

CREATE POLICY tenant_isolation ON "public"."kb_page_purge_ledger"
  USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."kb_page_purge_ledger" TO streamline_app;
