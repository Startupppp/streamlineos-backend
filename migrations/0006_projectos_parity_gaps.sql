-- ProjectOS parity gaps (2026-07-22): project priority, ticket<->customer link, project-scoped KB pages.
-- Apply via `pnpm -C backend db:push` (schema-diff) or run this file directly. Idempotent.

ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "priority" text;

ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "customer_id" integer REFERENCES "crm_organizations"("id") ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS "idx_tickets_customer" ON "tickets" ("customer_id");

ALTER TABLE "kb_pages" ADD COLUMN IF NOT EXISTS "project_id" integer REFERENCES "projects"("id") ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS "idx_kb_pages_project_id" ON "kb_pages" ("project_id");
