# Inventory partition decision — G2

**Decision: do not partition `inv_stock_transactions` or `inv_audit_events` yet.**

Measured on the Neon branch behind `DATABASE_URL` on 2026-08-29 at ~20:00.

> ⚠ **The measurement no longer reproduces on that URL.** Re-checked at ~21:20 the
> same day, `DATABASE_URL` resolves to the same Neon endpoint but to an *empty*
> database: 749 public tables, **zero rows in every one of them** (`organizations`
> included), `pg_stat_user_tables.n_tup_ins = 0` and `reltuples = -1` — never
> inserted into, not deleted from. Somebody rebuilt the branch cold between the
> two readings. The numbers below are a real reading of a real ledger and the
> decision they support is unchanged, but re-run the query at the bottom before
> citing them again.

| Table | Exact rows | Planner estimate | Total size | Oldest row | Newest row |
|---|---:|---:|---:|---|---|
| `inv_stock_transactions` | **32,245** | 32,242 | 27 MB | 2026-08-27 17:28:56 | 2026-08-29 14:25:47 |
| `inv_audit_events` | **68** | 50 | 304 kB | 2026-08-27 11:20:05 | 2026-08-29 14:28:55 |
| `inv_stock_levels` (context) | 3,322 | 3,319 | 3,128 kB | — | — |

For scale, `notifications` in the same database *is* partitioned and carries 49 partitions.

## Why not now

`backend/CLAUDE.md` §3 says to partition high-volume append-only tables by time, and it also says: *"Don't partition a table that isn't demonstrably large; record the triggering row count in the migration."* Neither of these is demonstrably large.

- 32k rows in 27 MB is a table Postgres reads happily from any of its twelve indexes. The `(org_id, created_at DESC, id DESC)` index that G1's keyset cursor rides is 32k entries deep; a partition scheme would add planning cost and constraint-exclusion work to buy nothing.
- `inv_audit_events` at 68 rows is not a candidate under any reading.
- The whole two days of history is a seeded development branch, not production traffic. Partitioning on a growth rate that has never been observed would be fitting a scheme to a guess.

## What it would cost to be wrong in the other direction

Partitioning is not reversible cheaply here, and the ledger has structure that makes the conversion expensive:

- **The partition key must be in every PK and UNIQUE.** `inv_stock_transactions` currently has `PRIMARY KEY (id)` plus two unique indexes that do not carry `created_at`: `uniq_inv_stock_transactions_org_id (org_id, id)` and the partial `uniq_inv_stock_transactions_correction_of (org_id, correction_of_transaction_id) WHERE correction_of_transaction_id IS NOT NULL`. Both would have to grow a `created_at` column, and the second one is what makes A2's "a movement may be reversed exactly once" true under a race. Weakening it to accommodate a partition key would reopen a correctness hole that took a migration to close.
- **Five inbound foreign keys reference it**, four of them on the composite tenant key `(org_id, id)`:
  - `fk_inv_val_layers_txn` → `(id)`
  - `fk_inv_valuation_layers_stock_transaction_id_org` → `(org_id, id)`
  - `fk_inv_val_consumptions_org_txn` → `(org_id, id)`
  - `fk_inv_avg_cost_history_org_txn` → `(org_id, id)`
  - `fk_inv_stock_transactions_correction_of_org` → `(org_id, id)` (self-referential, `ON DELETE RESTRICT`)

  A partitioned parent cannot be the target of a foreign key unless the referenced columns include the partition key, so every one of these five would have to be rewritten to carry `created_at` — including the self-reference that links a correction to what it corrects. Valuation layers, consumptions and average-cost history all hang off that key; getting it wrong detaches the cost side of the ledger from the ledger.

That is a substantial, correctness-sensitive migration. It is worth doing when the table is large. It is not worth doing at 32k rows.

## The trigger

Revisit when **either** holds:

1. `inv_stock_transactions` passes **50 million rows** or **50 GB**, or
2. a `VACUUM ANALYZE`d ledger list read measures more than ~2,000 buffers as `streamline_app` with the tenant GUC set (measure in buffers, not milliseconds — `backend/CLAUDE.md` §7).

Re-measure with:

```sql
SELECT c.relname,
       c.reltuples::bigint  AS estimated_rows,
       pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('inv_stock_transactions', 'inv_audit_events');
```

## The scheme, when the trigger fires

Recorded now so the decision is not re-litigated later:

- RANGE partition on `created_at`, **monthly**, partitions pre-created a quarter ahead.
- `PRIMARY KEY (id, created_at)`. Bare `id` stops being globally unique; every consumer that carries a transaction id must carry its `created_at` alongside.
- Keep the tenant key as `UNIQUE (org_id, id, created_at)` so `(org_id, id)` lookups stay index-served and the four composite FKs have a target.
- Rewrite the five inbound FKs onto the widened key, each as `ADD CONSTRAINT … NOT VALID` then `VALIDATE CONSTRAINT`, in separate migrations (`backend/CLAUDE.md` §3 — an FK add takes ACCESS EXCLUSIVE on both tables).
- Archive with `DETACH PARTITION CONCURRENTLY` + `DROP TABLE`, never a bulk `DELETE`.
- The migration that does it records the row count that triggered it, per the rule.

`inv_audit_events` is the easy half — no inbound FKs at all — and can follow the same scheme independently, on its own trigger.
