-- Accounting's four scopable read keys stop offering `own` and `team`, because nothing could
-- ever apply them: `accounting:journal:read`, `accounting:receivables:read`,
-- `accounting:payables:read`, `accounting:approvals:read`.
--
-- All four declared `scopable: true` and no route ever read a scope from one.
-- `src/modules/accounting/` contains no `applyScope`, no `DataScope`, no `readRequestScope`
-- and no warehouse-style equivalent; the eleven read routes across `kernel.controller.ts`,
-- `ar-invoices`, `ar-receipts`, `ar-aging`, `ap-documents` and `ap-payments` pass `orgId`
-- alone. `PermissionGuard` resolves the grant, attaches it as `req.rbacScope` and ALLOWS the
-- request — narrowing is the route's job, and none of these opt in. That is a REQUIREMENT
-- nothing satisfies: an administrator picks `own` on the access screen, the product accepts
-- it, stores it and shows it back, and every journal and invoice in the organisation stays
-- visible.
--
-- Withdrawn rather than implemented, because a ledger read has no honest per-person owner.
-- Checked column by column before writing this, since the opposite fix would have been to
-- enforce the scope:
--
--   * `gl_journals` — the only candidate is `posted_by_user_id`, which is nullable and
--     `ON DELETE SET NULL`, so journals would drop out of a narrowed read the day the poster
--     left. Most of the 18 `gl_journal_source` values are machine-posted (`fx_reval`,
--     `payroll_run`, `bank_fee`, `billing_invoice`, `withholding`, `depreciation`,
--     `stock_move`, `period_close`); "posted by" is whoever clicked a button in another
--     module, or nobody.
--   * `ar_documents` / `ap_documents` — only `created_by` and `posted_by`, both nullable and
--     `ON DELETE SET NULL`. That is who KEYED the row, not who owns it; narrowing to it
--     empties the ledger for the AR manager who keyed none.
--   * `gl_parties` — the customer or vendor — has no owner column at all. It reaches CRM only
--     through the `external_refs` jsonb, deliberately ("a pointer, never a copy"), because
--     accounting must work with CRM absent (A12). Scoping through a CRM account owner would
--     return nothing for every accounting-native party.
--
-- And the aggregates over the same rows are not scopable and could not be: trial balance
-- (`accounting:reports:read`) and account ledger (`accounting:general-ledger:read`) read the
-- journals that `accounting:journal:read` lists, and neither key is scopable. Narrowing the
-- detail while the totals stay whole restricts nothing — it only stops the two agreeing.
-- `ArAgingService` shows the same seam from the other side: `reconciliation.balanced` is
-- asserted against a book-wide AR control account and is suppressed only when the CALLER
-- filtered (`scoped = Boolean(query.partyId || query.currency)`, `ar-aging.service.ts`). An
-- invisible RBAC filter would not set that flag, so `GET ar/aging` and `GET ar/open-items` —
-- both gated on `accounting:receivables:read` — would compare a subset against the whole
-- control balance and report the ledger as unbalanced.
--
-- `accounting:approvals:read` is withdrawn for a different reason: it has no route at all.
-- Its sibling `accounting:approvals:decide` is used by `hr-workflow-engine.service.ts` and
-- `hr-workflow-instances.service.ts` purely as a role marker, resolved through
-- `membersWithPermission` for the `finance_role` assignee rule. If a read surface is ever
-- built it will read `hr_workflow_instances`, and "approvals assigned to me" belongs there,
-- on HR's key, against HR's assignee column — not here. The key is kept rather than retired
-- because organisations already hold it; that is a separate decision from whether it
-- promises a scope.
--
-- Why a migration and not just the catalogue edit. `PermissionCatalogSyncService` writes
-- `permission_supported_scopes` with `insert(...).onConflictDoNothing()` and has no delete
-- branch; it is the only writer, and no migration has ever deleted from that table.
-- Migration 0343 is the sole seeder and named all four at both `team` and `own`. So removing
-- `scopable: true` stops the offer on a fresh database and leaves 0343's rows standing in
-- every existing one — the code would be honest and the database would still be lying.
-- Measured on `streamline_crm_merge` after the catalogue edit: all four still read
-- `all,own,team`.
--
-- Grant normalisation is defensive, not corrective: measured before writing this, all four
-- keys hold exactly 4 `role_permission_grants` each and every one is at `all`, and
-- `user_permission_grants` holds none. So this withdraws a dormant offer and moves nobody's
-- access. It is written anyway because a migration must be correct on a database it has not
-- seen.
SET lock_timeout = '5s';
--> statement-breakpoint
-- ── grant tables ────────────────────────────────────────────────────────────────────────
-- Any narrow grant is a restriction that was never enforced, so `all` is what the holder has
-- actually had all along. Widening the stored value to match observed behaviour changes no
-- one's access; leaving it would strand a scope the catalogue no longer offers.
UPDATE "role_permission_grants"
SET "scope" = 'all'
WHERE "permission_key" IN (
  'accounting:approvals:read',
  'accounting:journal:read',
  'accounting:payables:read',
  'accounting:receivables:read'
)
  AND "scope" <> 'all';
--> statement-breakpoint
UPDATE "user_permission_grants"
SET "scope" = 'all'
WHERE "permission_key" IN (
  'accounting:approvals:read',
  'accounting:journal:read',
  'accounting:payables:read',
  'accounting:receivables:read'
)
  AND "scope" <> 'all';
--> statement-breakpoint
-- `user_delegation_permissions` has no scope column, so a delegation carries nothing to fix.
-- ── supported scopes ────────────────────────────────────────────────────────────────────
-- What 0343 offered. `all` stays: it is the row the sync service writes for every key,
-- scopable or not, and deleting it would make the key ungrantable.
DELETE FROM "permission_supported_scopes"
WHERE "permission_key" IN (
  'accounting:approvals:read',
  'accounting:journal:read',
  'accounting:payables:read',
  'accounting:receivables:read'
)
  AND "scope" IN ('own', 'team');
--> statement-breakpoint
-- ── cache invalidation ──────────────────────────────────────────────────────────────────
-- Resolution is cached per (userId, orgId) and busted by permissions_version. The UPDATEs
-- above are no-ops on every database measured, but a bump costs one resolution and skipping
-- it on a database where they were not would leave a stale scope until the TTL expired.
INSERT INTO "access_versions" ("org_id", "permissions_version", "updated_at")
SELECT o."id", 2, now()
FROM "organizations" o
ON CONFLICT ("org_id") DO UPDATE
SET "permissions_version" = "access_versions"."permissions_version" + 1,
    "updated_at" = now();
