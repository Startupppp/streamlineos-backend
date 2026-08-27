-- Custom SQL migration file, put your code below! --

-- The MCP surface: which tenants turned it on, and what each token may do.
--
-- Two tables, and neither is a credential. The credential is `agent_tokens`,
-- which already hashes, expires and revokes; ticket 19's second criterion says
-- to reuse it rather than stand a parallel one beside it, so nothing here
-- stores a secret, an expiry or a revocation. `crm_mcp_token_grants` points at
-- a token that exists and dies with it.
--
-- `crm_mcp_server_enablement` is a per-tenant switch that is off when the row
-- is absent. It is not `org_modules`, and the reason is not preference:
-- `isCoreModuleKey` answers TRUE for any module key with no entry in
-- `MODULE_REGISTRY`, so a key like `crm-mcp` would resolve as a core module —
-- always available to every tenant — which is a permission surface failing open
-- on exactly the input it cannot reason about. Enabling through `org_modules`
-- requires a registry entry first, and that is a product decision about the
-- modules screen and plan gating rather than something a protocol surface may
-- mint for itself. See `src/db/schema/crm/crm-mcp.ts`.
--
-- No actor column here references `users`. `scripts/purge-user.mjs` deletes
-- every row whose column references it, so offboarding the administrator who
-- enabled the server would switch the surface off for the whole tenant, and
-- offboarding the one who scoped a token would silently widen or narrow what
-- that token can do. Migration 0223 removed exactly this pair of edges from
-- `autonomous_decisions`.
--
-- Authored by hand; see 0205 for why db:generate cannot run in this repository.

SET lock_timeout = '5s';

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crm_mcp_server_enablement" (
  "organization_id" text PRIMARY KEY NOT NULL,
  -- Present and false is a tenant who turned it off, which is not the same fact
  -- as a tenant who never turned it on. Both mean the surface is unreachable;
  -- only one of them has a person and a date attached.
  "enabled" boolean DEFAULT false NOT NULL,
  "enabled_at" timestamp,
  "enabled_by" text,
  "disabled_at" timestamp,
  "disabled_by" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
-- An enabled row that cannot say who enabled it is an anonymous grant of a
-- protocol surface over a customer's CRM. The whole point of the criterion is
-- that somebody decided; a row that cannot name them has not recorded a
-- decision.
ALTER TABLE "crm_mcp_server_enablement"
  DROP CONSTRAINT IF EXISTS "chk_crm_mcp_server_enablement_deliberate";
--> statement-breakpoint
ALTER TABLE "crm_mcp_server_enablement" ADD CONSTRAINT "chk_crm_mcp_server_enablement_deliberate"
  CHECK ("enabled" IS FALSE OR ("enabled_at" IS NOT NULL AND "enabled_by" IS NOT NULL));

--> statement-breakpoint
ALTER TABLE "crm_mcp_server_enablement" ADD CONSTRAINT "fk_crm_mcp_server_enablement_org"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "crm_mcp_server_enablement" VALIDATE CONSTRAINT "fk_crm_mcp_server_enablement_org";

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crm_mcp_token_grants" (
  "crm_mcp_token_grant_id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "agent_token_id" integer NOT NULL,
  -- A key from `ALL_PERMISSION_NAMES`. An uncatalogued key is denied by
  -- `authorize()` before anything else looks at it, so a bad grant is inert
  -- rather than dangerous — but it still reads as access on an administrator's
  -- screen, so the service refuses to write one.
  "permission_key" text NOT NULL,
  "granted_at" timestamp DEFAULT now() NOT NULL,
  "granted_by" text
);

--> statement-breakpoint
-- Composite on the tenant, so a grant can never point at another
-- organisation's token even if the application forgets to say which
-- organisation it is in. `uniq_agent_tokens_org_id` is the referent this
-- targets, and it already exists for precisely this kind of edge.
ALTER TABLE "crm_mcp_token_grants" ADD CONSTRAINT "fk_crm_mcp_token_grants_token"
  FOREIGN KEY ("organization_id", "agent_token_id")
  REFERENCES "agent_tokens"("org_id", "id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "crm_mcp_token_grants" VALIDATE CONSTRAINT "fk_crm_mcp_token_grants_token";

--> statement-breakpoint
ALTER TABLE "crm_mcp_token_grants" ADD CONSTRAINT "fk_crm_mcp_token_grants_org"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "crm_mcp_token_grants" VALIDATE CONSTRAINT "fk_crm_mcp_token_grants_org";

--> statement-breakpoint
-- One grant per key per token. Without this, a replace that raced with another
-- would leave duplicates, and a later delete-by-key would clear one of them and
-- leave the token still holding the permission an administrator just removed.
ALTER TABLE "crm_mcp_token_grants" ADD CONSTRAINT "uniq_crm_mcp_token_grants_key"
  UNIQUE ("organization_id", "agent_token_id", "permission_key");

--> statement-breakpoint
-- The read on every single protocol call: this token's whole grant list.
CREATE INDEX IF NOT EXISTS "idx_crm_mcp_token_grants_token"
  ON "crm_mcp_token_grants" ("organization_id", "agent_token_id");

--> statement-breakpoint
ALTER TABLE "crm_mcp_server_enablement" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "crm_mcp_server_enablement";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "crm_mcp_server_enablement"
  FOR ALL USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "crm_mcp_server_enablement" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "crm_mcp_server_enablement" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "crm_mcp_token_grants" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "crm_mcp_token_grants";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "crm_mcp_token_grants"
  FOR ALL USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "crm_mcp_token_grants" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "crm_mcp_token_grants" TO streamline_app;

--> statement-breakpoint
ANALYZE "crm_mcp_server_enablement";
--> statement-breakpoint
ANALYZE "crm_mcp_token_grants";
