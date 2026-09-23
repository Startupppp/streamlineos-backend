SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('build.change_requests') IS NULL THEN
    RAISE EXCEPTION '1163 precondition: build.change_requests is absent — this is not a Build database';
  END IF;
  IF to_regclass('build.tickets') IS NULL THEN
    RAISE EXCEPTION '1163 precondition: build.tickets is absent — this is not a Build database';
  END IF;
  IF to_regclass('build.change_request_affected_items') IS NOT NULL THEN
    RAISE EXCEPTION '1163 precondition: build.change_request_affected_items already exists — this migration has run';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_change_requests_org_id') THEN
    RAISE EXCEPTION '1163 precondition: uniq_change_requests_org_id is absent — the tenant-safe composite foreign key cannot be declared';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_tickets_org_id') THEN
    RAISE EXCEPTION '1163 precondition: uniq_tickets_org_id is absent — the tenant-safe composite foreign key cannot be declared';
  END IF;
END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "build"."change_request_affected_items" (
  "id" integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "org_id" text NOT NULL,
  "change_request_id" integer NOT NULL,
  "ticket_id" integer NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "created_by" text,
  CONSTRAINT "uniq_change_request_affected_items_org_id" UNIQUE ("org_id", "id")
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_change_request_affected_items_pair"
  ON "build"."change_request_affected_items" ("change_request_id", "ticket_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_change_request_affected_items_org_cr"
  ON "build"."change_request_affected_items" ("org_id", "change_request_id", "ticket_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_change_request_affected_items_org_ticket"
  ON "build"."change_request_affected_items" ("org_id", "ticket_id", "change_request_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_change_request_affected_items_created_by"
  ON "build"."change_request_affected_items" ("created_by");
--> statement-breakpoint

ALTER TABLE "build"."change_request_affected_items"
  ADD CONSTRAINT "change_request_affected_items_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "public"."organizations" ("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."change_request_affected_items"
  VALIDATE CONSTRAINT "change_request_affected_items_org_id_organizations_id_fk";
--> statement-breakpoint

ALTER TABLE "build"."change_request_affected_items"
  ADD CONSTRAINT "fk_change_request_affected_items_org_change_request"
  FOREIGN KEY ("org_id", "change_request_id") REFERENCES "build"."change_requests" ("org_id", "id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."change_request_affected_items"
  VALIDATE CONSTRAINT "fk_change_request_affected_items_org_change_request";
--> statement-breakpoint

ALTER TABLE "build"."change_request_affected_items"
  ADD CONSTRAINT "fk_change_request_affected_items_org_ticket"
  FOREIGN KEY ("org_id", "ticket_id") REFERENCES "build"."tickets" ("org_id", "id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."change_request_affected_items"
  VALIDATE CONSTRAINT "fk_change_request_affected_items_org_ticket";
--> statement-breakpoint

ALTER TABLE "build"."change_request_affected_items"
  ADD CONSTRAINT "change_request_affected_items_created_by_users_id_fk"
  FOREIGN KEY ("created_by") REFERENCES "public"."users" ("id") ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."change_request_affected_items"
  VALIDATE CONSTRAINT "change_request_affected_items_created_by_users_id_fk";
--> statement-breakpoint

ALTER TABLE "build"."change_request_affected_items" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "build"."change_request_affected_items";
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "build"."change_request_affected_items"
  USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "build"."change_request_affected_items" TO streamline_app;
