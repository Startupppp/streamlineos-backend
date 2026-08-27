# Inventory schema audit — 2026-08-27

## Decision

Do not delete the inventory schema from a shared or production database.

The configured live database was inspected read-only. It contains exactly 66 `inv_*` tables. The core inventory tables currently contain no business rows; the only non-empty inventory table is `inv_reason_codes` with 40 seeded rows. That makes a clean rebuild technically possible on this database, but it is still not a safe `DROP ... CASCADE` exercise because application code and other modules depend on the table contracts.

Recommended direction: treat the current database as an inventory v1 compatibility surface, then either:

1. harden and normalize it in place with additive migrations; or
2. build a v2 inventory core beside it, migrate the empty/seed-only data, switch service contracts, and retire v1 only after dependency and route verification.

For this repository, option 2 is reasonable because the live inventory data set is effectively empty. It must still preserve the integration contracts described below and must not be implemented as an unreviewed destructive drop.

## What exists

The Drizzle entry point is `src/db/schema/index.ts`, which exports `src/db/schema/inventory/index.ts`. The inventory schema is split into:

| Area | Source file | Responsibility |
|---|---|---|
| Catalog | `core.ts` | UoM, categories, products, variants, product UoM conversions, barcodes |
| Facilities | `warehouses.ts` | Warehouses, locations, user-to-warehouse grants |
| Stock kernel | `stock.ts` | Stock projection, immutable stock transactions, adjustments, transfers |
| Procurement | `purchase-orders.ts` | Vendors, purchase orders, PO lines, GRNs, GRN lines |
| Order fulfillment | `sales-orders.ts`, `shipping.ts`, `operations.ts` | Sales orders, picks, shipments, packages, loads |
| Allocation | `reservations.ts` | Stock reservations and idempotency/source linkage |
| Traceability | `traceability.ts` | Lots and serial numbers |
| Quality | `quality.ts` | Inspections, holds, recalls |
| Returns/counting | `operations.ts` | Vendor/customer returns, cycle counts, physical audits |
| Valuation | `valuation.ts` | FIFO/average valuation layers and cost history |
| Planning | `planning.ts` | Reorder rules and AI insights |
| Channels | `channels.ts` | Channel publication and 3PL connections |
| Platform operations | `admin.ts` | Settings, reason codes, numbering, import/export, audit, idempotency, webhooks |

The 66 live tables are:

```text
inv_3pl_connections                 inv_ai_insights
inv_audit_events                    inv_average_cost_history
inv_barcodes                        inv_carriers
inv_categories                      inv_channel_stock_publications
inv_channels                        inv_customer_return_lines
inv_customer_returns                inv_cycle_count_lines
inv_cycle_counts                    inv_export_jobs
inv_grn_lines                       inv_grns
inv_idempotency_keys                inv_import_jobs
inv_load_lines                      inv_loads
inv_locations                       inv_lots
inv_number_sequences                inv_package_lines
inv_packages                        inv_physical_audit_lines
inv_physical_audits                 inv_pick_list_lines
inv_pick_lists                       inv_po_lines
inv_product_uom_conversions          inv_product_variants
inv_products                        inv_purchase_orders
inv_quality_holds                   inv_quality_inspection_lines
inv_quality_inspections             inv_reason_codes
inv_recall_events                   inv_recall_lines
inv_reorder_rules                   inv_sales_orders
inv_serial_numbers                  inv_settings
inv_shipment_lines                  inv_shipments
inv_so_lines                        inv_standard_costs
inv_stock_adjustment_lines          inv_stock_adjustments
inv_stock_levels                    inv_stock_reservations
inv_stock_transactions              inv_stock_transfer_lines
inv_stock_transfers                 inv_uom
inv_user_warehouses                 inv_valuation_consumptions
inv_valuation_layers                inv_vendor_return_lines
inv_vendor_returns                  inv_vendors
inv_warehouses                      inv_webhook_event_subscriptions
inv_webhook_events                  inv_webhooks
```

## Live catalog findings

The read-only catalog inspection used the local `DATABASE_URL`; no write, migration, seed, or delete was performed.

- 66 inventory tables exist.
- 65 inventory tables have RLS enabled and a `tenant_isolation` policy.
- `inv_webhook_event_subscriptions` has RLS disabled and no policy. This is a concrete tenant-isolation gap.
- The live database has 86 composite foreign keys and 195 single-column foreign keys on inventory tables. The composite keys were added by the repository-wide tenant hardening migrations (`0320`–`0323`), not consistently represented in the inventory TypeScript definitions.
- 58 inventory primary keys use sequence defaults; 8 use `GENERATED ALWAYS AS IDENTITY`. The current backend rule requires identity or UUID keys for new tables, so this is a legacy mixed state.
- No inventory table has a `deleted_at` column.
- The live line tables have denormalized `org_id` columns (`inv_po_lines`, `inv_so_lines`, shipment/package/pick/count/return/quality lines, and others), but the corresponding Drizzle definitions do not declare those columns. This is schema drift between the code model and the live catalog.
- `inv_settings` contains both `adjustment_approval_threshold` and `adjustment_approval_value_threshold`, showing an additive migration that has not completed its contract cleanup.
- Exact row counts across all 66 live inventory tables: 40 rows in `inv_reason_codes`; 0 rows in every other `inv_*` table.

The live RLS policy shape is tenant equality using the database's current-org resolver, with both `USING` and `WITH CHECK` predicates. The database role used for inspection is an owner role, so this inspection does not prove application-role behavior; RLS must still be tested as `streamline_app` with and without tenant context.

## Strengths worth preserving

- `inv_stock_transactions` is modeled as an append-only movement record with before/after quantities, costs, references, posting date, and idempotency metadata.
- `inv_stock_levels` has a natural-key uniqueness rule across tenant, variant, location, lot, and serial grain.
- UoM conversions are product-specific and enforce a positive conversion factor.
- FIFO valuation was made location/lot-aware, and COGS tables use tenant-composite references.
- Reservation idempotency and active source-line uniqueness were added deliberately.
- Webhook subscriptions were normalized from a JSONB array into an indexed child table.
- The AI inventory services already use the shared AI gateway, so OpenRouter should remain a provider choice behind that gateway rather than becoming an inventory-specific provider path.

## Structural risks

### 1. The Drizzle schema is not the complete live contract

The live catalog has tenant columns and composite FKs that are absent from several inventory schema files. If Claude Code regenerates migrations from the current TypeScript definitions without first reconciling this drift, it can propose destructive or contradictory changes.

Before any migration generation, reconcile the live catalog into the Drizzle schema or explicitly record the database-only compatibility constraints.

### 2. Tenant integrity is uneven in source definitions

Many source-level references are single-column FKs such as `product_variant_id -> inv_product_variants.id`, while the tenant match is enforced only in the live database by supplementary composite FKs. New v2 tables should define tenant-composite relationships from the beginning rather than relying on a later generic repair pass.

### 3. Inventory quantities are mostly service-enforced

The source schema has only two explicit inventory `CHECK` constraints: positive UoM conversion factor and the barcode exclusive arc. It does not visibly enforce non-negative quantities, committed/on-hand bounds, received/shipped limits, positive transaction quantities where applicable, lot/serial tracking consistency, or `available = on_hand - committed - blocked - quality_hold`.

Those invariants should be made explicit in the v2 stock kernel, with the service transaction and database constraints agreeing on the same state machine.

### 4. Business entities have no soft-delete/archive state

Products, variants, vendors, warehouses, locations, orders, stock documents, and operational records have no `deleted_at` field. This conflicts with the backend's default archival policy and makes historical inventory references harder to preserve safely.

The ledger itself should remain immutable. Master data and documents should use explicit lifecycle/archive fields where deletion would destroy audit meaning.

### 5. The module still crosses CRM/accounting boundaries

- `inv_vendors` references CRM `clients` and also carries the newer `client_party_id` migration field.
- `inv_sales_orders` references CRM `clients` and CRM `invoices`, and also carries `client_party_id`.
- Customer returns reference CRM clients/parties.
- Billing offer fulfillment stores tenant-scoped inventory SKU ids (`inv_product_variants`) and validates them in application code.
- Deal-closed fulfillment creates inventory sales orders.
- Organization hierarchy dependency checks read inventory warehouses.
- The platform AI ops copilot reads inventory products, variants, and stock.
- Cron pruning reads and deletes inventory idempotency keys.

The inventory v2 core can be inventory-only, but these contracts need adapters or compatibility views during cutover. Deleting the tables without updating these consumers will break billing, deal fulfillment, organization hierarchy, AI tools, and cron jobs.

### 6. Several legacy/additive shapes remain

- Products and variants both carry barcode and pricing/cost fields.
- Vendors and customer-facing order/return records carry both legacy client ids and party ids.
- Webhooks retain the old JSONB event list while the normalized subscription table exists.
- Stock transactions and reservations retain generic source/reference pointers. These may be useful for audit display, but they should not be the only referential path for a business relationship.

## Recommended rebuild boundary

If the decision is to rebuild while the live inventory data is empty, rebuild only the inventory-owned core and preserve integration boundaries:

1. Tenant and identity seam: organization, actor, authorization, audit, idempotency.
2. Catalog: item, variant/SKU, UoM, conversion, barcode, category, vendor reference.
3. Facility: warehouse, location, location hierarchy, access scope.
4. Stock kernel: immutable movement ledger, lot/serial grain, stock projection, reservation/commitment state, reconciliation.
5. Procurement and receiving: PO, receiving event, discrepancy/quality outcome.
6. Outbound: order demand, allocation, pick, pack, shipment, dispatch.
7. Planning and evidence: reorder policy, forecast inputs, supplier performance, AI insight evidence.
8. Compatibility adapters: billing offer fulfillment, deal-closed consumer, CRM/party references, accounting posting references, AI tools, webhooks, and cron idempotency.

The v2 design should use identity/UUID keys, tenant-composite FKs, explicit lifecycle fields, strict quantity/cost checks, immutable movement facts, projections that can be rebuilt, and one transaction boundary for every stock-affecting command.

## Safe execution sequence

1. Freeze the live catalog as a read-only baseline and reconcile the Drizzle definitions with the 66-table catalog.
2. Add schema contract tests for table/column/FK/RLS parity and cross-tenant rejection.
3. Choose either in-place hardening or parallel v2 tables. Do not mix an unreviewed drop with the first implementation phase.
4. Build and test the stock kernel first: receipt, adjustment, transfer, reservation, release, shipment, and reconciliation under concurrency.
5. Migrate the 40 reason-code rows and any future seeded configuration.
6. Switch backend services through adapters, then frontend query contracts, then AI tools and webhooks.
7. Verify the application role, tenant isolation, idempotency replay, audit history, and rollback on a disposable database.
8. Only after all consumers are removed and the migration manifest is approved should the old tables be retired.

## Bottom line

Starting clean is viable on the current empty/seed-only inventory database, but the right clean start is a controlled v2 inventory rebuild with compatibility seams—not a blanket deletion of every `inv_*` table. The first implementation ticket should be schema/catalog reconciliation, because the live database already contains tenant hardening that the TypeScript schema does not fully express.
