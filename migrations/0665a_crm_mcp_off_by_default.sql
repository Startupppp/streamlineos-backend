-- Custom SQL migration file, put your code below! --

-- Agent access to the CRM, as a decision a tenant makes.
--
-- CRM-P2-09. The MCP surface is authorized per tool and per credential: every
-- tool declares its own permission, an agent token is clamped to its own scopes,
-- and module entitlement is resolved per key. All of that answers "may this
-- caller run this tool". None of it answers the question a tenant actually has,
-- which is whether they want a machine touching their customer records at all --
-- and an admin holds `crm:deals:read` because they read deals, not because they
-- consented to an agent reading them.
--
-- The absence of a row means off. That is the safe reading for a capability
-- nobody asked for, and it is why `enabled` is not simply defaulted true.
--
-- The backfill is the other half and it is not a convenience. Turning this off
-- for organisations that already mint agent tokens would be a silent outage
-- dressed up as a security improvement: their integrations would start failing
-- with no deploy note and no setting anybody had touched. An unrevoked,
-- unexpired token is a tenant that demonstrably opted in, so those rows are
-- written enabled and everybody else starts off.

SET lock_timeout = '5s';

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crm_mcp_settings" (
  "organization_id" text PRIMARY KEY NOT NULL,
  "enabled" boolean NOT NULL DEFAULT false,
  "updated_by_user_id" text,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
ALTER TABLE "crm_mcp_settings"
  ADD CONSTRAINT "fk_crm_mcp_settings_org"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "crm_mcp_settings" VALIDATE CONSTRAINT "fk_crm_mcp_settings_org";

--> statement-breakpoint
-- Every organisation that already has a live agent token keeps its agent access.
INSERT INTO "crm_mcp_settings" ("organization_id", "enabled")
SELECT DISTINCT t."org_id", true
FROM "agent_tokens" t
JOIN "organizations" o ON o."id" = t."org_id"
WHERE t."revoked_at" IS NULL
  AND (t."expires_at" IS NULL OR t."expires_at" > now())
ON CONFLICT ("organization_id") DO NOTHING;

--> statement-breakpoint
ALTER TABLE "crm_mcp_settings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "crm_mcp_settings";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "crm_mcp_settings"
  FOR ALL USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "crm_mcp_settings" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "crm_mcp_settings" TO streamline_app;

--> statement-breakpoint
ANALYZE "crm_mcp_settings";
