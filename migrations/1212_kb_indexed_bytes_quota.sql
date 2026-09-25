-- 1212 — Indexed-bytes accounting, tenant-leading.
--
-- One row per organisation, tracking how many bytes of source content that tenant has
-- indexed against their cap. The service enforces the cap before accepting a new source;
-- this table is the durable authority. A missing row means no bytes have been indexed yet
-- (treated as 0 by the enforcement logic) and will be INSERT-initialised on first write.
--
-- limit_bytes defaults to 512 MiB (536870912). That default matches the platform-tier cap
-- documented in the subscription catalogue. Changing a tenant's cap is a BYPASSRLS UPDATE
-- performed by the control-plane worker, not by the application role.
--
-- Rollback: migrations/rollback/1212_kb_indexed_bytes_quota.down.sql
SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('public.organizations') IS NULL THEN
    RAISE EXCEPTION '1212 precondition: public.organizations is absent';
  END IF;
END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "public"."kb_indexed_bytes_quota" (
  "org_id"        text        PRIMARY KEY
                               REFERENCES "public"."organizations"("id") ON DELETE CASCADE,
  "indexed_bytes" bigint      NOT NULL DEFAULT 0,
  "limit_bytes"   bigint      NOT NULL DEFAULT 536870912,
  "updated_at"    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "chk_kb_indexed_bytes_quota_non_negative"
    CHECK ("indexed_bytes" >= 0 AND "limit_bytes" >= 0)
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_kb_indexed_bytes_quota_org"
  ON "public"."kb_indexed_bytes_quota" ("org_id");
--> statement-breakpoint

ALTER TABLE "public"."kb_indexed_bytes_quota" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

DROP POLICY IF EXISTS tenant_isolation ON "public"."kb_indexed_bytes_quota";
--> statement-breakpoint

CREATE POLICY tenant_isolation ON "public"."kb_indexed_bytes_quota"
  USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON "public"."kb_indexed_bytes_quota" TO streamline_app;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'kb_indexed_bytes_quota'
  ) THEN
    RAISE EXCEPTION '1212 postcondition: kb_indexed_bytes_quota table was not created';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'kb_indexed_bytes_quota'
      AND column_name = 'indexed_bytes'
  ) THEN
    RAISE EXCEPTION '1212 postcondition: indexed_bytes column is absent';
  END IF;
END $$;
--> statement-breakpoint
