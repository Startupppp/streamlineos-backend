# INV-110 — inventory read-cost evidence, 2026-08-28

First measured run. Until today these budgets had never executed.

## Why they had never run

Three separate reasons, each of which alone was enough:

1. **No non-BYPASSRLS role was reachable.** The harness requires
   `APP_DATABASE_URL`, and `.env` records that it is "deliberately unset" —
   Neon manages role credentials in its control plane, so `streamline_app`'s
   password reverts when the compute suspends. Measuring as `neondb_owner`
   is measuring nothing: it holds BYPASSRLS, so the tenant predicate never
   enters the plan and every cost the harness exists to catch is invisible.

2. **Three of the five budget queries did not compile.** They named columns and
   an enum value that do not exist: `inv_stock_levels.quantity_available` and
   `.quantity_reserved` (the columns are `on_hand`, `committed`, `blocked_qty`,
   `quality_hold_qty`, `outgoing_qty`), `inv_stock_transactions.quantity` (it is
   `quantity_change`), and `status <> 'ARCHIVED'` against an enum whose members
   are `ACTIVE`, `INACTIVE`, `DISCONTINUED`.

3. **`minRows` hid all of it.** At 10–100 rows every budget reported
   `seed-too-small` and skipped, so the broken SQL was never executed and
   nobody learned it was broken.

## What changed

**Role.** `neondb_owner` was already a member of `streamline_app` with admin
option, but PostgreSQL 16 separates the `SET` privilege from membership, so
`SET ROLE` was refused. One grant fixes it permanently and cannot expire:

```sql
GRANT streamline_app TO neondb_owner WITH SET TRUE;
```

The harness now assumes that role per measurement transaction (`APP_DB_ROLE`,
default `streamline_app`) when `APP_DATABASE_URL` is absent, and **refuses to
run** if the effective role turns out to hold BYPASSRLS. Failing closed matters
here: a misconfigured role does not error, it quietly reports comfortable
numbers that mean nothing.

**Queries.** The three broken budgets now name real columns.

**Dataset.** `src/scripts/seed-inventory-load.mjs` spreads a tagged dataset
across eight organisations. The tenant share is the point, not the row count:
the seed organisation previously held 87% of every inventory table, so
`org_id = $1` selected almost the whole relation and a sequential scan was the
*correct* plan. The first run's three "Seq Scan" failures were not findings —
they were the benchmark measuring itself. The measured tenant is now ~13-15% of
each table and the planner reaches for the index.

## Measured

`node src/scripts/run-read-cost-budgets.mjs --ids=inv-…`, as `streamline_app`
(no BYPASSRLS), tenant GUC set, `EXPLAIN (ANALYZE, BUFFERS)`, shared hit + read
blocks.

| Budget | Blocks | Ceiling | Plan assertion |
|---|---:|---:|---|
| `inv-products-list` | 48 | 10,000 | no seq scan on `inv_products` ✓ |
| `inv-stock-levels` | 5 | 10,000 | no seq scan on `inv_stock_levels` ✓ |
| `inv-stock-transactions` | 421 | 15,000 | no seq scan on `inv_stock_transactions` ✓ |
| `inv-purchase-orders` | 18 | 8,000 | no seq scan on `inv_purchase_orders` ✓ |
| `inv-vendors-list` | 6 | 5,000 | no seq scan on `inv_vendors` ✓ |

Dataset at time of measurement: 3,303 products · 32,237 stock transactions ·
4,850 purchase orders · 1,220 vendors, across 8 organisations.

## What this does not yet prove

The PRD's targets — 250k SKUs, 1k locations, 10M movements, P95 < 500 ms — are
**not** demonstrated. This run is three orders of magnitude below the movement
target, and it measures buffers rather than latency under concurrency. What it
establishes is narrower and was previously absent entirely: the queries compile,
the tenant-led indexes are chosen rather than assumed, and the harness now
produces a number at all.

Reaching PRD scale means ~10M `inv_stock_transactions` rows, which is a
disposable-environment job rather than something to do to a shared development
branch other sessions are working on.

## Other modules

Executing every budget definition surfaced three broken outside inventory, left
alone as out of scope but recorded here because they are the same failure mode —
a budget that has never run: `kb-spaces-list` (`cover_image` does not exist),
`leave-ledger-mine` (`entry_type`), `deals-pipeline` (`title`).
