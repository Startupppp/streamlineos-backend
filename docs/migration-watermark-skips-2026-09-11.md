# Fifteen journalled migrations that `db:migrate` will never apply

**Measured 2026-09-11 against the shared Neon branch
(`ep-orange-mode-azxn5hbr-pooler.c-3.ap-southeast-1.aws.neon.tech`), read-only.**

> Tags are shown under the names they carry after the 2026-09-11 cross-lane
> collision renames (a letter suffix, e.g. `0520b_`). Content, hash and `when`
> are unchanged, so the applied/unapplied split below is unaffected.

## What was measured

- `drizzle.__drizzle_migrations` holds **858** applied rows; the highest
  `created_at` — the watermark — is **1803000010160**.
- `migrations/meta/_journal.json` holds **635** entries.
- Of the 23 files `check:migration-discipline` flags, **8 are applied and 15 are
  not**. Membership was decided by `sha256(fileContent)`, which is the only key
  `__drizzle_migrations` has: the table stores `(hash, created_at)` and no tag.
- **All 15 unapplied entries carry a `when` at or below the watermark.**

| tag | journal `when` |
|---|---|
| 0519_inventory_resumable_import | 1700000315000 |
| 0520b_rbac_membership_keys | 1700000316000 |
| 0521a_drop_resurrected_sku_uniques | 1700000317000 |
| 0522a_grn_discrepancy | 1700000318000 |
| 0523a_pick_line_exceptions | 1700000319000 |
| 0524a_cartonization | 1700000320000 |
| 0527_po_batching_policy | 1700000323000 |
| 0529_ledger_corrections_and_immutability | 1700000325000 |
| 0540b_package_sales_order_link | 1700000336000 |
| 0543b_pick_exception_ownership | 1700000341000 |
| 0544b_inspection_plans | 1700000340000 |
| 0581a_inventory_quick_commerce_asn | 1700000359000 |
| 0582_notifications_partition_by_created_at | 1700000379000 |
| 0589_inventory_drop_reason_codes | 1700000367000 |
| 0611_delegations_and_overrides_expand_membership | 1700000394000 |

## Why they are skipped

`db:migrate` is `drizzle-kit migrate`, which selects journal entries whose
`when` is greater than the last applied `created_at`. `run-pending-migrations.mjs`
does the same thing explicitly at line 66:

    queue = journal.entries.filter((e) => e.when > watermark)

Both then print success. So these fifteen are not pending — on this database
they are **unreachable**, and every future run will report nothing to do.

The `when` values are the giveaway: `1700000…` is the numbering an earlier lane
used, while the chain-repair entries that lifted the watermark carry
`1798000…`/`1803000…`. Once one entry with a far-future `when` was applied, every
lower-numbered entry behind it stopped being eligible. That is the same
mechanism `check:migration-discipline` reports as `journal-order`, seen from the
database side.

## What is in the fifteen

Not cosmetic. `0529_ledger_corrections_and_immutability` is the GL correction and
immutability pass; `0520b_rbac_membership_keys` and
`0611_delegations_and_overrides_expand_membership` are membership-actor
contractions the application code already assumes; `0582` partitions
`notifications` by `created_at`.

## Why this is not fixed here

Three candidate fixes, each a decision rather than an edit:

1. **Apply them explicitly.** `db:apply-one --tag=<tag>` keys on the content
   hash, not on `when`, so it can apply an entry the watermark hides. This is the
   narrow fix, but several of the fifteen are non-idempotent (`ADD CONSTRAINT`,
   `DROP INDEX`, a partition rewrite) and the live schema has moved since they
   were written, so each needs to be read against the current catalog before it
   is run. It also writes to the shared database.
2. **Rewrite the `when` values** so the journal is monotonic again. This is the
   edit `check:migration-chain` (c) and the journal-idx rule both warn against —
   it changes which entries every OTHER database considers pending, and the
   damage is silent.
3. **Change the runner to select by hash-absence in journal order** and let the
   existing per-file hash check do the skipping (`run-pending-migrations.mjs`
   already does that check inside `applyOne`). Correct and idempotent in
   principle, but it would make the next `db:migrate` on any database attempt all
   fifteen at once, which is decision 1 without the reading.

The cold path is unaffected: `db:bootstrap` walks the journal from an empty
database in order and reaches head, which is why this never showed up there.

**Owner decision required before any of the three.** Nothing in this branch
changes migration files, `_journal.json`, or the runner.
