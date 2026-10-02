SET lock_timeout = '5s';
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_outbox_events_org_event_id"
  ON "outbox_events" ("organization_id", "event_id");
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_invitations_org_id_setup_receipts"
  ON "invitations" ("org_id", "id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "organization_setup_invitation_receipts" (
  "org_id" text NOT NULL,
  "producer_event_id" text NOT NULL,
  "canonical_email" text NOT NULL,
  "invitation_id" text,
  "outcome" text NOT NULL,
  "reason_code" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "pk_organization_setup_invitation_receipts"
    PRIMARY KEY ("org_id", "producer_event_id", "canonical_email"),
  CONSTRAINT "fk_organization_setup_invitation_receipts_event"
    FOREIGN KEY ("org_id", "producer_event_id")
    REFERENCES "outbox_events" ("organization_id", "event_id") ON DELETE CASCADE,
  CONSTRAINT "fk_organization_setup_invitation_receipts_invitation"
    FOREIGN KEY ("org_id", "invitation_id")
    REFERENCES "invitations" ("org_id", "id") ON DELETE CASCADE,
  CONSTRAINT "ck_organization_setup_invitation_receipts_email"
    CHECK ("canonical_email" = lower(btrim("canonical_email")) AND "canonical_email" <> ''),
  CONSTRAINT "ck_organization_setup_invitation_receipts_outcome"
    CHECK (
      ("outcome" = 'SKIPPED_SELF' AND "invitation_id" IS NULL AND "reason_code" IS NULL)
      OR ("outcome" = 'REFUSED' AND "invitation_id" IS NULL AND "reason_code" = 'UNKNOWN')
      OR ("outcome" = 'QUEUED' AND "invitation_id" IS NOT NULL AND "reason_code" IS NULL)
      OR ("outcome" = 'DELIVERY_FAILED' AND "invitation_id" IS NOT NULL AND "reason_code" = 'EMAIL_NOT_SENT')
    )
);
--> statement-breakpoint

ALTER TABLE "organization_setup_invitation_receipts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "tenant_isolation" ON "organization_setup_invitation_receipts"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint

REVOKE ALL ON "organization_setup_invitation_receipts" FROM PUBLIC;
--> statement-breakpoint

GRANT SELECT, INSERT ON "organization_setup_invitation_receipts" TO streamline_app;
