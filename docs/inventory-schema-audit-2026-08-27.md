# Inventory schema audit — 2026-08-27

## Decision

Do not delete the inventory schema from a shared or production database.

The configured live database was inspected read-only. It contains exactly 66 `inv_*` tables. The core inventory tables contain no business rows; the only non-empty inventory table is `inv_reason_codes` with 40 seeded rows. A clean rebuild is technically possible on this database, but it is still not a safe `DROP ... CASCADE` exercise because application code and other modules depend on these table contracts.

Recommended direction: treat the current database as an inventory v1 compatibility surface, then build a controlled v2 inventory core beside it or harden it in place. Because the live inventory data set is empty/seed-only, a v2 rebuild is reasonable, but it must preserve compatibility adapters and must not be an unreviewed destructive reset.

## Current domain surface

The Drizzle entry point is `src/db/schema/index.ts`, which exports `src/db/schema/inventory/index.ts`. The inventory schema covers:

| Area | Source file(s) | Responsibility |
|---|---|---|
| Catalog | `core.ts` | UOM, categories, products, variants, conversions, barcodes |
| Facilities | `warehouses.ts` | Warehouses, locations, warehouse access |
| Stock kernel | `stock.ts` | Stock projection, movement ledger, adjustments, transfers |
| Procurement | `purchase-orders.ts` | Vendors, POs, PO lines, GRNs |
| Fulfillment | `sales-orders.ts`, `shipping.ts`, `operations.ts` | Orders, picks, shipments, packages, loads |
| Allocation | `reservations.ts` | Reservations and idempotency/source linkage |
| Traceability | `traceability.ts` | Lots and serials |
| Quality | `quality.ts` | Inspections, holds, recalls |
| Returns/counts | `operations.ts` | Vendor/customer returns, cycle counts, physical audits |
| Valuation | `valuation.ts` | FIFO/average layers and cost history |
| Planning/channels | `planning.ts`, `channels.ts` | Reorder rules, AI insights, channel/3PL publication |
| Platform operations | `admin.ts` | Settings, reasons, numbering, jobs, audit, webhooks |

## Live catalog findings

The read-only catalog inspection used the local `DATABASE_URL`; no write, migration, seed, or delete was performed.

- 66 inventory tables exist.
- 65 inventory tables have RLS enabled and a `tenant_isolation` policy.
- `inv_webhook_event_subscriptions` has RLS disabled and no policy.
- The live inventory tables have 86 composite foreign keys and 195 single-column foreign keys. The composite keys come from repository-wide tenant hardening migrations `0320`–`0323` and are not fully represented in the inventory TypeScript definitions.
- 58 inventory primary keys use sequence defaults; 8 use `GENERATED ALWAYS AS IDENTITY`.
- No inventory table has a `deleted_at` column.
- Many live line tables have denormalized `org_id` columns that the corresponding Drizzle definitions do not declare, creating code/catalog drift.
- `inv_settings` retains both `adjustment_approval_threshold` and `adjustment_approval_value_threshold`.
- Exact row counts across all 66 inventory tables: 40 rows in `inv_reason_codes`; 0 rows in every other `inv_*` table.

The live RLS policy uses tenant equality with both `USING` and `WITH CHECK`. The inspection role is an owner role, so application-role behavior still requires explicit testing as `streamline_app` with correct, missing, and wrong tenant context.

## Strengths to preserve

- `inv_stock_transactions` is an append-only movement record with before/after quantities, costs, references, posting date, and idempotency metadata.
- `inv_stock_levels` has a tenant/SKU/location/lot/serial natural-key uniqueness rule.
- UOM conversions are product-specific and enforce a positive factor.
- Valuation was made location/lot-aware; COGS tables use tenant-composite references.
- Reservation idempotency and active source-line uniqueness exist.
- Webhook subscriptions were normalized from a JSONB array into an indexed child table.
- Inventory AI already uses the shared AI gateway; OpenRouter should remain behind that gateway.

## Structural risks

1. **Drizzle/live drift:** regenerating migrations from the current TypeScript definitions without catalog reconciliation can propose contradictory changes, especially around line-table `org_id` columns and composite FKs.
2. **Uneven source-level tenant integrity:** many source definitions show single-column FKs even though the live catalog supplements them with composite tenant FKs. New v2 relationships should be composite from creation.
3. **Weak database invariants:** inventory has only two explicit CHECK constraints—positive conversion factor and barcode exclusive arc. Non-negative quantities, availability bounds, receipt/shipment limits, serial/lot consistency, and movement arithmetic are mostly service-enforced.
4. **No archive semantics:** inventory entities have no `deleted_at` or equivalent archive field. The ledger must remain immutable; master data and documents need controlled lifecycle state.
5. **Cross-module coupling:** vendors/orders/returns touch CRM clients/parties and invoices; billing offer fulfillment references inventory SKUs; deal fulfillment creates inventory orders; organization hierarchy reads warehouses; AI tools read products/stock; cron prunes inventory idempotency keys.
6. **Legacy/additive shapes:** products and variants duplicate barcode/pricing fields; vendor/order/return records carry client and party ids; webhooks retain the old JSONB event list; generic source/reference pointers remain and must not be the sole enforcement path.

## Recommended rebuild boundary

If rebuilding while inventory data is empty, preserve these seams:

1. Tenant/identity, authorization, audit, and idempotency.
2. Catalog: item, SKU/variant, UOM, conversion, barcode, category, vendor reference.
3. Facility: warehouse, location hierarchy, and access scope.
4. Stock kernel: immutable ledger, lot/serial grain, projection, reservations, reconciliation.
5. Procurement/receiving: PO, receipt, discrepancy, and quality outcome.
6. Outbound: demand, allocation, pick, pack, shipment, dispatch.
7. Planning/evidence: reorder policy, forecasts, supplier performance, AI evidence.
8. Compatibility adapters for billing, CRM/party references, accounting, deal fulfillment, AI tools, webhooks, and cron.

The v2 design should use identity/UUID keys, tenant-composite FKs, explicit lifecycle fields, strict quantity/cost checks, immutable movement facts, rebuildable projections, and one transaction boundary for every stock-affecting command.

## Safe execution sequence

1. Freeze and reconcile the live catalog with Drizzle.
2. Add schema parity, RLS, cross-tenant, and projection reconciliation tests.
3. Choose in-place hardening or parallel v2 tables; do not mix an unreviewed drop with implementation.
4. Build and concurrency-test the stock kernel first.
5. Migrate the 40 reason-code rows and future configuration.
6. Switch backend services, frontend contracts, AI tools, and webhooks through adapters.
7. Rehearse application-role isolation, idempotency, audit, rollback, backup/restore, and cutover on a disposable production-sized environment.
8. Retire old tables only after every consumer is removed and the migration manifest is approved.

## Bottom line

Starting clean is viable on the current empty/seed-only inventory database, but the right clean start is a controlled v2 inventory rebuild with compatibility seams—not a blanket deletion of every `inv_*` table. Schema/catalog reconciliation is the first implementation gate.
