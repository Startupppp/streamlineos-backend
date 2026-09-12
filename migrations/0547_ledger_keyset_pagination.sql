-- 0547 — G1. The keyset every movements and audit-trail page now walks.
--
-- `inv_stock_transactions` and `inv_audit_events` were both paged with OFFSET
-- over `ORDER BY created_at DESC`. Two faults, one index each.
--
--   1. `created_at` alone is not a total order. One posting writes every line of
--      a receipt inside a single transaction, so a dozen rows carry the same
--      `now()` to the microsecond. Any cursor on the timestamp alone lands in
--      the middle of such a group and either repeats those rows on the next page
--      or steps over them — on an append-only ledger, that reads as stock that
--      was never received. The cursor is `(created_at, id)`; `id` is unique per
--      tenant by `uniq_inv_stock_transactions_org_id` /
--      `uniq_inv_audit_events_org_id`, so the pair is total.
--
--   2. No index led `(org_id, created_at, id)`. Measured as `streamline_app`
--      with the tenant GUC set, on the seed organisation's 4,200-row ledger:
--      page one of the movements list cost 849 shared blocks, because the
--      planner reached for `idx_inv_txn_created` — which does not lead with
--      `org_id`, so under RLS the tenant qual is checked against the heap tuple
--      and the scan walks every organisation's rows to find fifty of one's own.
--      Deeper pages fell back to a bitmap scan of the tenant's whole ledger plus
--      a sort: 94 blocks here, and linear in the tenant thereafter. With this
--      index both shapes settle at single digits and stay there at any depth,
--      because a keyset scan reads exactly the page it returns.
--
-- Both new indexes are declared DESC/DESC so the index order is literally the
-- page order. Postgres could scan an ASC index backwards, but writing the
-- direction down is what keeps a future `ORDER BY` edit from silently costing a
-- sort.
--
-- `idx_inv_txn_org_created` and `idx_inv_audit_org_created` are dropped: each is
-- an exact leading prefix of its replacement, so nothing they answered is lost,
-- and on an append-only table that is written to on every posting a redundant
-- index is pure write amplification.
--
-- `idx_inv_txn_created` — bare `(created_at)`, no `org_id` — is dropped too, and
-- this one is not housekeeping. With it present the planner took it for every
-- keyset page and left the row comparison as a heap Filter: 421 shared blocks
-- for page two, scanning eight organisations' rows to return fifty of one's own,
-- because §7's rule bites here exactly as written — the index cannot supply
-- `org_id`, the RLS qual is not leakproof, so the tenant test happens after the
-- heap fetch. Dropped, the same page resolves as one Index Cond on
-- `idx_inv_txn_org_created_id` — `(org_id = $1 AND ROW(created_at, id) < ROW(...))`
-- — for 7 blocks and no sort. Nothing needed a tenant-less `created_at` index:
-- `org_id` is NOT NULL on this table, RLS is enabled, and every reader in the
-- module is tenant-scoped, so the index could only ever have been the wrong half
-- of a plan.
--
-- Locking notes, per §3 Migrations. `CREATE INDEX` takes SHARE and `DROP INDEX`
-- takes ACCESS EXCLUSIVE briefly; `lock_timeout` makes either fail fast rather
-- than queue and block every writer behind it. The CONCURRENTLY forms cannot be
-- used — drizzle's runner wraps all pending migrations in one transaction and
-- neither may appear in a transaction block (see 0533's header). No column,
-- type or constraint is added, so there is nothing to add NOT VALID.

SET lock_timeout = '5s';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_inv_txn_org_created_id"
  ON "inv_stock_transactions" ("org_id", "created_at" DESC, "id" DESC);
--> statement-breakpoint

DROP INDEX IF EXISTS "idx_inv_txn_org_created";
--> statement-breakpoint

DROP INDEX IF EXISTS "idx_inv_txn_created";
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_inv_audit_org_created_id"
  ON "inv_audit_events" ("org_id", "created_at" DESC, "id" DESC);
--> statement-breakpoint

DROP INDEX IF EXISTS "idx_inv_audit_org_created";
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- `inventory:audit:read`, and the backfill without which it reaches nobody.
-- ---------------------------------------------------------------------------
-- `inv_audit_events` has been written since the module shipped and read by
-- nothing but D7's export. `GET /inventory/audit-events` is its first read
-- surface, and it needs a key of its own: `inventory:audit:export` is the right
-- to take a checksummed evidence bundle away, not the right to look at the
-- trail. The catalogue row has to exist before any grant can name it —
-- `role_permission_grants.permission_key` is a foreign key onto
-- `permissions.name`, and `PermissionCatalogSyncService` writes that row at
-- application boot, which is after this migration runs.
INSERT INTO "permissions" ("name", "resource", "action", "description", "module_key", "is_delegable")
VALUES (
  'inventory:audit:read',
  'inventory:audit',
  'read',
  'Read the inventory audit trail — who changed which record, and when',
  'inventory',
  true
)
ON CONFLICT ("name") DO NOTHING;
--> statement-breakpoint

INSERT INTO "permission_supported_scopes" ("permission_key", "scope")
VALUES ('inventory:audit:read', 'all')
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- Role templates grant on role CREATION only, so a new key reaches no existing
-- organisation without this. The slugs are the three `seedSystemRolesForOrg`
-- actually mints — not the `ROLE_TEMPLATES` slugs seven CRM migrations granted
-- to and reached nobody with.
--
-- `INVENTORY_MODULE_MEMBER` is included here and `0539` excluded it, and both
-- are right: `buildModuleMemberPermissionKeys` takes every module key ending in
-- `:view` or `:read`, so a freshly seeded organisation gives its module members
-- `inventory:audit:read` and withholds `inventory:audit:export`. Backfilling
-- anything else would make an organisation's capability depend on its signup
-- date, which is the divergence 0226 exists to prevent. The trail this key opens
-- is who-changed-what, not the before/after payloads — the list endpoint does
-- not project `before`, `after` or `metadata`, for the same reason D7's export
-- hashes them.
INSERT INTO "role_permission_grants" ("org_id", "role_id", "permission_key", "scope")
SELECT r."org_id", r."id", 'inventory:audit:read', 'all'
FROM "roles" r
WHERE r."is_system" = true
  AND r."slug" IN ('INVENTORY_MODULE_OWNER', 'INVENTORY_MODULE_ADMIN', 'INVENTORY_MODULE_MEMBER')
ON CONFLICT DO NOTHING;
--> statement-breakpoint

INSERT INTO "access_versions" ("org_id", "permissions_version", "updated_at")
SELECT DISTINCT r."org_id", 2, now()
FROM "roles" r
WHERE r."is_system" = true
  AND r."slug" IN ('INVENTORY_MODULE_OWNER', 'INVENTORY_MODULE_ADMIN', 'INVENTORY_MODULE_MEMBER')
ON CONFLICT ("org_id") DO UPDATE
SET "permissions_version" = "access_versions"."permissions_version" + 1,
    "updated_at" = now();
