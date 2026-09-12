-- Custom SQL migration file, put your code below! --

-- 0657 — where a WhatsApp business line lives, so an inbound delivery can find
-- the secret that proves it and the tenant it belongs to.
--
-- The adapter has been in the tree since phase 2 with its binding passed in
-- rather than looked up, because `user_integration_connections.toolkit` is a
-- closed union over gmail/outlook/googlecalendar and widening it would change a
-- column three other adapters read. This is the narrower answer.
--
-- Nothing here can act on the organisation's behalf. `app_secret` authenticates
-- the provider TO us; it is not a provider access token and cannot send a
-- message, read history, or reach anything outside the CRM. Both secrets are
-- stored as `enc:v1:` ciphertext by the application (secret-encryption.util).
--
-- Authored by hand; see 0205 for why db:generate cannot run here.

SET lock_timeout = '5s';

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crm_whatsapp_channels" (
  "crm_whatsapp_channel_id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,

  -- metadata.phone_number_id — what a delivery has to match to be ours.
  "business_phone_number_id" text NOT NULL,
  -- The business's own number, as the other end of the participant pair.
  "business_number" text NOT NULL,

  -- Encrypted at rest. Verifies the provider's signature; never a send credential.
  "app_secret" text NOT NULL,
  -- Encrypted at rest. Echoed once, during the subscription handshake.
  "verify_token" text,

  "enabled" boolean DEFAULT true NOT NULL,

  -- What the last delivery came to, so a channel that files nothing says why.
  "last_delivery_at" timestamp,
  "last_accepted_at" timestamp,
  "last_note" text,

  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
ALTER TABLE "crm_whatsapp_channels" ADD CONSTRAINT "fk_crm_whatsapp_channels_org"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "crm_whatsapp_channels" VALIDATE CONSTRAINT "fk_crm_whatsapp_channels_org";

--> statement-breakpoint
-- Globally unique, not unique per organisation, and that is the security
-- property rather than a modelling preference: the resolver below runs BEFORE
-- any tenant is known, so a second row claiming the same line would make the
-- answer a function of row order — i.e. one tenant could be handed another's
-- conversations by inserting a row.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_crm_whatsapp_channel_line"
  ON "crm_whatsapp_channels" ("business_phone_number_id");

--> statement-breakpoint
-- The tenant-scoped composite the platform rule asks for. Implied by the index
-- above and kept anyway: it is the one a per-org read plans against, and the
-- global unique is a security invariant that should be free to change shape
-- without silently removing a tenant index underneath it.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_crm_whatsapp_channel_org_line"
  ON "crm_whatsapp_channels" ("organization_id", "business_phone_number_id");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_crm_whatsapp_channel_org"
  ON "crm_whatsapp_channels" ("organization_id")
  WHERE "enabled" = true;

--> statement-breakpoint
ALTER TABLE "crm_whatsapp_channels" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "crm_whatsapp_channels";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "crm_whatsapp_channels"
  FOR ALL USING (organization_id = app.current_org_id_or_null())
  WITH CHECK (organization_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "crm_whatsapp_channels" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "crm_whatsapp_channels" TO streamline_app;

--> statement-breakpoint
-- Resolve the tenant for an inbound delivery, same shape as 0385/0386/0387.
--
-- An inbound WhatsApp webhook arrives with no session and cannot name an
-- organisation — it names the business line it landed on, and the tenant is
-- read from that. The table is behind `tenant_isolation`, so the lookup that
-- finds WHICH secret to verify against has no tenant context to run in.
--
-- Returning the org id only, rather than adding an id-keyed arm to the policy,
-- is the narrower fix: a policy arm would grant blanket read of the FULL row —
-- `app_secret` included — to any present or future unguarded query against this
-- table, not just to this one handler.
CREATE OR REPLACE FUNCTION app.resolve_whatsapp_channel_org_id(p_phone_number_id text) RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT organization_id
  FROM crm_whatsapp_channels
  WHERE business_phone_number_id = p_phone_number_id
    AND enabled = true;
$$;
--> statement-breakpoint

COMMENT ON FUNCTION app.resolve_whatsapp_channel_org_id(text) IS
  'Returns only the organization_id for an enabled WhatsApp business line, bypassing RLS for that single column so an inbound delivery can resolve its tenant before its signature is verified. Never expose any other column (esp. app_secret or verify_token) through this path.';
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.resolve_whatsapp_channel_org_id(text) FROM PUBLIC;
--> statement-breakpoint

DO $$
DECLARE
  app_role text := coalesce(current_setting('app.bootstrap_role', true), 'streamline_app');
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION app.resolve_whatsapp_channel_org_id(text) TO %I', app_role);
  END IF;
END $$;
--> statement-breakpoint

-- The same lookup keyed on the channel's own id, for the callback URL a tenant
-- configures at the provider. The handshake (`GET ?hub.verify_token=`) carries
-- no phone number id at all, so without this there is no way to answer it.
CREATE OR REPLACE FUNCTION app.resolve_whatsapp_channel_org_id_by_id(p_channel_id text) RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT organization_id
  FROM crm_whatsapp_channels
  WHERE crm_whatsapp_channel_id = p_channel_id
    AND enabled = true;
$$;
--> statement-breakpoint

COMMENT ON FUNCTION app.resolve_whatsapp_channel_org_id_by_id(text) IS
  'Returns only the organization_id for an enabled WhatsApp channel by its own id, so the provider subscription handshake — which carries no phone number id — can resolve its tenant. Never expose any other column through this path.';
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.resolve_whatsapp_channel_org_id_by_id(text) FROM PUBLIC;
--> statement-breakpoint

DO $$
DECLARE
  app_role text := coalesce(current_setting('app.bootstrap_role', true), 'streamline_app');
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION app.resolve_whatsapp_channel_org_id_by_id(text) TO %I', app_role);
  END IF;
END $$;

--> statement-breakpoint
ANALYZE "crm_whatsapp_channels";
