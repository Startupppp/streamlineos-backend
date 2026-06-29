CREATE UNIQUE INDEX IF NOT EXISTS "uniq_timesheets_work_log" ON "timesheets" ("org_id","user_id","date") WHERE ticket_id IS NULL;
