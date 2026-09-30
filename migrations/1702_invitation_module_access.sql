SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('invitations') IS NULL THEN
    RAISE EXCEPTION '1702 precondition: invitations table is absent';
  END IF;
END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "invitation_module_access" (
  "id"             INTEGER     GENERATED ALWAYS AS IDENTITY
                               CONSTRAINT pk_invitation_module_access PRIMARY KEY,
  "org_id"         TEXT        NOT NULL,
  "invitation_id"  TEXT        NOT NULL,
  "module_key"     TEXT        NOT NULL,
  "standing"       TEXT        NOT NULL,
  "created_at"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_ima_standing CHECK (standing IN ('MEMBER', 'ADMIN'))
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_ima_invitation_module"
  ON "invitation_module_access" ("invitation_id", "module_key");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_ima_org_invitation"
  ON "invitation_module_access" ("org_id", "invitation_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_ima_invitation_id"
  ON "invitation_module_access" ("invitation_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_ima_org_id"
  ON "invitation_module_access" ("org_id");
--> statement-breakpoint

ALTER TABLE "invitation_module_access"
  ADD CONSTRAINT "fk_ima_org"
  FOREIGN KEY ("org_id")
  REFERENCES "organizations" ("id")
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint

ALTER TABLE "invitation_module_access"
  VALIDATE CONSTRAINT "fk_ima_org";
--> statement-breakpoint

ALTER TABLE "invitation_module_access"
  ADD CONSTRAINT "fk_ima_invitation"
  FOREIGN KEY ("invitation_id")
  REFERENCES "invitations" ("id")
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint

ALTER TABLE "invitation_module_access"
  VALIDATE CONSTRAINT "fk_ima_invitation";
--> statement-breakpoint

ALTER TABLE "invitation_module_access" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

DROP POLICY IF EXISTS tenant_isolation ON "invitation_module_access";
--> statement-breakpoint

CREATE POLICY tenant_isolation ON "invitation_module_access"
  FOR ALL
  USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON "invitation_module_access" TO streamline_app;
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('invitation_module_access') IS NULL THEN
    RAISE EXCEPTION '1702: invitation_module_access table was not created';
  END IF;
  ASSERT (
    SELECT relrowsecurity FROM pg_class
    WHERE relname = 'invitation_module_access'
      AND relnamespace = 'public'::regnamespace
  ), '1702 post-check: RLS not enabled on invitation_module_access';
  ASSERT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'invitation_module_access'
      AND policyname = 'tenant_isolation'
  ), '1702 post-check: tenant_isolation policy not found on invitation_module_access';
END $$;
--> statement-breakpoint
