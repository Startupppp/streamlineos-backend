SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('invitations') IS NULL THEN
    RAISE EXCEPTION '1611 precondition: invitations table is absent';
  END IF;
END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "invitation_email_otps" (
  "id"            INTEGER     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "invitation_id" TEXT        NOT NULL REFERENCES "invitations"("id") ON DELETE CASCADE,
  "code_hash"     TEXT        NOT NULL,
  "expires_at"    TIMESTAMPTZ NOT NULL,
  "used_at"       TIMESTAMPTZ,
  "attempts"      INTEGER     DEFAULT 0 NOT NULL,
  "created_at"    TIMESTAMPTZ DEFAULT NOW() NOT NULL
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_invitation_email_otps_inv_expires"
  ON "invitation_email_otps" ("invitation_id", "expires_at");
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON "invitation_email_otps" TO streamline_app;
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('invitation_email_otps') IS NULL THEN
    RAISE EXCEPTION '1611: invitation_email_otps was not created';
  END IF;
END $$;
--> statement-breakpoint
