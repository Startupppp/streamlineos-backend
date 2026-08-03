SET statement_timeout = 0;
-- 0338 — module-level ownership and ownership transfer handshake
-- =============================================================================
-- module_ownerships: one designated owner per module per org.
-- ownership_transfers: auditable lifecycle entity for both org- and module-level
--   ownership transfers, requiring explicit acceptance by the recipient.
--
-- Composite FKs to organization_members(org_id, id) rely on the existing
-- candidate-key constraint uniq_org_members_org_id (UNIQUE (org_id, id)).
--
-- Two partial unique indexes enforce at most one PENDING transfer per scope:
--   uniq_ownership_xfers_org_pending_org    — only one pending org transfer
--   uniq_ownership_xfers_org_pending_module — one pending per (org, module_key)
--
-- CHECK constraint enforces: module_key IS NOT NULL if and only if scope='MODULE'.
-- =============================================================================

CREATE TABLE "module_ownerships" (
  "id"                  uuid        NOT NULL DEFAULT gen_random_uuid(),
  "org_id"              text        NOT NULL,
  "module_key"          text        NOT NULL,
  "owner_membership_id" integer     NOT NULL,
  "created_at"          timestamptz NOT NULL DEFAULT now(),
  "updated_at"          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "module_ownerships_pkey"
    PRIMARY KEY ("id"),
  CONSTRAINT "uniq_module_ownerships_org_module"
    UNIQUE ("org_id", "module_key"),
  CONSTRAINT "fk_module_ownerships_org"
    FOREIGN KEY ("org_id")
    REFERENCES "organizations" ("id")
    ON DELETE CASCADE,
  CONSTRAINT "fk_module_ownerships_member"
    FOREIGN KEY ("org_id", "owner_membership_id")
    REFERENCES "organization_members" ("org_id", "id")
    ON DELETE RESTRICT
);
--> statement-breakpoint

CREATE INDEX "idx_module_ownerships_org"
  ON "module_ownerships" ("org_id");
--> statement-breakpoint

CREATE TABLE "ownership_transfers" (
  "id"                  uuid        NOT NULL DEFAULT gen_random_uuid(),
  "org_id"              text        NOT NULL,
  "scope"               text        NOT NULL,
  "module_key"          text,
  "from_membership_id"  integer     NOT NULL,
  "to_membership_id"    integer     NOT NULL,
  "status"              text        NOT NULL DEFAULT 'PENDING',
  "initiated_at"        timestamptz NOT NULL DEFAULT now(),
  "responded_at"        timestamptz,
  "expires_at"          timestamptz NOT NULL,
  "reason"              text,
  CONSTRAINT "ownership_transfers_pkey"
    PRIMARY KEY ("id"),
  CONSTRAINT "chk_ownership_transfers_module_key_scope"
    CHECK ((module_key IS NOT NULL) = (scope = 'MODULE')),
  CONSTRAINT "fk_ownership_transfers_org"
    FOREIGN KEY ("org_id")
    REFERENCES "organizations" ("id")
    ON DELETE CASCADE,
  CONSTRAINT "fk_ownership_transfers_from_member"
    FOREIGN KEY ("org_id", "from_membership_id")
    REFERENCES "organization_members" ("org_id", "id")
    ON DELETE RESTRICT,
  CONSTRAINT "fk_ownership_transfers_to_member"
    FOREIGN KEY ("org_id", "to_membership_id")
    REFERENCES "organization_members" ("org_id", "id")
    ON DELETE RESTRICT
);
--> statement-breakpoint

CREATE INDEX "idx_ownership_transfers_org_status"
  ON "ownership_transfers" ("org_id", "status");
--> statement-breakpoint

CREATE INDEX "idx_ownership_transfers_to_pending"
  ON "ownership_transfers" ("org_id", "to_membership_id");
--> statement-breakpoint

CREATE INDEX "idx_ownership_transfers_expires"
  ON "ownership_transfers" ("expires_at");
--> statement-breakpoint

CREATE UNIQUE INDEX "uniq_ownership_xfers_org_pending_org"
  ON "ownership_transfers" ("org_id")
  WHERE status = 'PENDING' AND scope = 'ORGANIZATION';
--> statement-breakpoint

CREATE UNIQUE INDEX "uniq_ownership_xfers_org_pending_module"
  ON "ownership_transfers" ("org_id", "module_key")
  WHERE status = 'PENDING' AND scope = 'MODULE';
