SET lock_timeout = '5s';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_cal_exc_org_event_modified"
  ON "calendar_event_exceptions" ("org_id", "event_id", "modified_start")
  WHERE "modified_start" IS NOT NULL;
