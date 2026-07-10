ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "recurrence_next_run_at" timestamptz;

CREATE INDEX IF NOT EXISTS "idx_tickets_recurrence_next" ON "tickets" ("recurrence_next_run_at") WHERE "is_recurring" = true;
