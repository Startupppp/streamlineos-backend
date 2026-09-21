# Migrations 1141 and 1142 — static verification

**Date:** 2026-09-21 · **Branch:** `build/closure-i-migrations` · **Worktree:** `slos-be-i-migrations`

> **DATABASE APPLICATION STATUS: BLOCKED.**
> Nothing in this document was verified against a running PostgreSQL. No database was
> reachable from this machine and none was contacted. Every statement below is either
> **verified by running a static gate** or **verified by reading source**. A static pass
> is not an applied migration. 1141 and 1142 remain **UNAPPLIED**.

## Summary

| Item | Verdict | How |
|---|---|---|
| 1141 well-formed, journalled, reversible | OK | read + gates |
| 1142 well-formed, journalled, reversible | OK | read + gates |
| 1142's `SET NULL (headcount_id)` column list correct | **UNVERIFIABLE statically** | see below |
| Journal integrity (BE-58/BE-59) | OK, one baselined NOTE | gate |
| Duplicate prefix `1090` | Real, already adjudicated — **do not touch** | gate baseline |
| `when` regression at `0619`/`0271a` | Real, already adjudicated — **do not touch** | gate NOTE |
| PostgreSQL floor | **Undeclared.** Guaranteed only in practice | repo search |

## Checks that RAN

All were proven to perform no database I/O by reading their source before running:
`check-migration-immutability.mjs`, `check-migration-rollback.mjs`,
`check-drop-column-safety.mjs`, `check-migration-discipline.mjs`,
`check-watermark-free-appliers.mjs` and `migration-plan.mjs` import only `node:fs`,
`node:path`, `node:url`, `node:os` and `node:crypto`. `guard-db-generate.mjs` imports
`node:child_process`, but `--check` calls `runCheck()`, which `process.exit()`s at both
of its exits (lines 79 and 87) and can never reach the `spawnSync("drizzle-kit", …)` at
line 148.

Self-tests were run first in every case, so none of these results is a vacuous pass.

```
pnpm typecheck                                  → exit 0
pnpm check:migration-discipline:self-test       → 27 passed, SELF-TEST PASSED, exit 0
pnpm check:migration-immutability:self-test     → 13 passed, exit 0
pnpm check:migration-rollback:self-test         →  9 passed, 0 failed, exit 0
pnpm check:drop-column-safety:self-test         → SELF-TEST PASSED, exit 0
pnpm check:db-generate-guard:self-test          → pass: true (6 checks), exit 0
pnpm check:watermark-free:self-test             → 10 checks, both directions bite, exit 0
pnpm check:set-null-column-lists:self-test      → 14 passed, exit 0
pnpm check:composite-fk-set-null:self-test      → 7/7 passed, exit 0
```

```
$ pnpm check:migration-discipline
  SQL files found: 903
  Baselines: lock_timeout=155 fk-not-valid=44 set-not-null=21 validate-order=2 do-breakpoint=0 no-journal=0 concurrently=0

  NOTE [journal-order] 0619_chain_creates_what_production_has.sql
    when=1787895425277 is not greater than the preceding entry 0271a_waitlist_admission
    (when=1803000010178) — harmless while every applier iterates the journal array and
    guards by file hash, and fatal the moment one selects by created_at watermark
    instead, which check:watermark-free enforces

check:migration-discipline PASSED
  903 SQL files checked, 0 new violations
exit 0
```

```
$ pnpm check:migration-immutability
check-migration-immutability: 685 sealed entries against a journal of 903 — 218 newly
appended, 400 comment-only edit(s)
OK — every sealed migration still builds the same database.
exit 0
```

```
$ pnpm check:migration-rollback
check:migration-rollback PASSED
  903 migrations scanned
  Compliance required for numeric prefix > 839
  All rollback type-name checks passed
exit 0
```

```
$ pnpm check:drop-column-safety
check-drop-column-safety: 903 migration file(s), 134 dropped column(s), 413 schema file(s)
  OK — no dropped column is still declared in the Drizzle schema
exit 0
```

```
$ pnpm check:db-generate-guard
check:db-generate-guard: 903 journal entries, latest snapshot 0464, real drift 438 —
db:generate is BLOCKED without ALLOW_DB_GENERATE=1.
exit 0
```

```
$ pnpm check:watermark-free
OK — 5 migration applier(s) iterate the journal and guard double application;
none selects by watermark.
exit 0
```

## Checks that are BLOCKED

**`pnpm check:set-null-column-lists` — half of it ran, half is blocked.** Reproduced in
this worktree with no database URL set:

```
Declared SET NULL foreign keys 606  ·  requiring a column list 286  ·  unreachable 0
Declaration half OK — every declared SET NULL key has at least one nullable member.
INCONCLUSIVE — the catalog half did not run. The ON DELETE SET NULL column list lives
only in pg_constraint.confdelsetcols; nothing static can see it, so 286 constraint(s)
are UNVERIFIED.
exit 2
```

Missing requirement: **a non-production, bootstrapped PostgreSQL 15+ reachable via
`SET_NULL_GATE_DATABASE_URL`. None exists on this machine.** This worktree has no
`.env`; the `backend/.env` in the main checkout points at production and is unusable for
this purpose — the production ledger is near-empty, so a replay there would attempt
roughly 1,105 migrations against the live database.

**`pnpm check:composite-fk-set-null` — BLOCKED.** It injects `.env` and opens a live
connection to read `pg_constraint`. Its self-test is hermetic and passes 7/7; the gate
itself was not run. Same missing requirement.

**Not run, production-touching by name:** `db:migrate`, `db:push`, `db:generate`,
`migration:proof`, `migration:proof:focused`, `check:migration-chain`,
`check:migration-ledger`, `db:verify-rls`, `openapi:generate`.

## Migration 1141 — `projects.pm_workspace_id` becomes nullable

Forward (`migrations/1141_projects_pm_workspace_optional.sql`) sets `lock_timeout` and
issues one statement: `ALTER TABLE "build"."projects" ALTER COLUMN "pm_workspace_id"
DROP NOT NULL`. Dropping NOT NULL is a catalog-only change; it takes no table rewrite.

Rollback (`migrations/rollback/1141_projects_pm_workspace_optional.down.sql`) exactly
reverses it, and does so via the repo's mandated NOT NULL two-step: `ADD CONSTRAINT …
CHECK (pm_workspace_id IS NOT NULL) NOT VALID` → `VALIDATE CONSTRAINT` → `SET NOT NULL`
→ `DROP CONSTRAINT`. The `SET NOT NULL` therefore never rewrites the table under an
ACCESS EXCLUSIVE lock. The rollback will correctly fail if any row has acquired a NULL
while 1141 was live; that is the intended behaviour, not a defect.

Journal entry: `idx 1029`, `when 1803000010410`, unique, and strictly greater than its
array predecessor `1140_exit_checklist_ownership` (`when 1803000010400`). It sits above
the seal's high-water mark of `1803000010136`, so the immutability gate classifies it as
a normal append rather than a back-dated insert.

**Drift to be aware of before deployment.** `src/db/schema/build/core.ts:46` already
declares `pmWorkspaceId: text("pm_workspace_id")` with no `.notNull()`, and the OpenAPI
contract was regenerated to publish it as nullable. Until 1141 is actually applied, the
database still carries the NOT NULL that `0333_pm_workspace_id_not_null.sql` installed.
In that window the type system and the published contract both say the field is
optional while a write that omits it raises `23502`. 1141 must land before anything
relies on the nullability.

## Migration 1142 — explicit column list on the requisition headcount FK

Forward (`migrations/1142_fix_requisition_headcount_fk_set_null.sql`) sets
`lock_timeout`, drops `fk_job_requisitions_headcount_org`, re-adds it as
`FOREIGN KEY ("org_id", "headcount_id") REFERENCES "headcount_requests"("org_id", "id")
ON DELETE SET NULL ("headcount_id") NOT VALID`, then `VALIDATE CONSTRAINT`. The
`NOT VALID` → `VALIDATE` split is present, so the constraint never takes ACCESS
EXCLUSIVE on both tables for the full trigger-install pass.

The premise is confirmed by reading `1128a_requisition_headcount_link.sql`, which
authored the constraint with a bare `ON DELETE SET NULL` over the composite key
`(org_id, headcount_id)`. `org_id` is NOT NULL, so a bare SET NULL would try to null it
and the parent delete would abort with `23502`. `headcount_id` is nullable — 1128a adds
it as plain `integer`. Naming only `headcount_id` is therefore the correct repair.

Rollback (`migrations/rollback/1142_fix_requisition_headcount_fk_set_null.down.sql`)
restores the exact 1128a form, and says in its own header that the restored state is the
broken one. It reverses the forward migration faithfully.

Journal entry: `idx 1030`, `when 1803000010420`, unique, strictly greater than 1141, and
above the seal high-water mark.

### The column list cannot be verified without a database

**A PostgreSQL `ON DELETE SET NULL` column list is stored only in
`pg_constraint.confdelsetcols`. No static check can see it.** This is not a gap in our
tooling that could be closed by writing a better gate:

- Drizzle cannot express it. `src/db/schema/hr/requisitions.ts:37` declares the same
  foreign key as `.onDelete("set null")` — the API has no parameter for a column list,
  so the schema is silent on the very thing 1142 changes.
- `check:set-null-column-lists` says so explicitly and exits 2 rather than passing:
  286 constraints are UNVERIFIED for exactly this reason.

**Reading the SQL is the only available evidence until a real database exists.** That
reading is clean, and it matches the pattern of
`0992_set_null_referential_actions_repair.sql`, which the migration cites. But it is
reading, not verification.

The unblock path already exists in CI: `.github/workflows/db-gates.yml:157` runs
`check:set-null-column-lists` with `SET_NULL_GATE_DATABASE_URL` pointed at the job's own
`pgvector/pgvector:pg16` service. Running that workflow is what turns this line green.

## PostgreSQL version

`ON DELETE SET NULL (column_list)` requires **PostgreSQL 15 or newer**.

**No file in this repository declares a required minimum PostgreSQL version.**
`package.json` has `"engines": { "node": ">=22" }` and no database engine field. There is
no `docker-compose.yml`, no `devcontainer.json`, no `.tool-versions`, no IaC, and no
boot-time or gate-time assertion on `current_setting('server_version_num')`. The README
and `CLAUDE.md` name no PostgreSQL version. **The floor is undeclared.**

PG 15+ is nonetheless guaranteed in practice, because every concrete environment named
anywhere is well above it:

| Environment | Version | Pinned or recorded at |
|---|---|---|
| CI — the only PG service in the repo | **16** | `.github/workflows/db-gates.yml:77, :409, :490` (`pgvector/pgvector:pg16`) |
| Production Aurora, ap-south-1 | 18.4 | `src/db/pool.config.ts:207`, `src/scripts/check-bootstrap-evidence.mjs:316` |
| Local scratch / benchmark box | 18.6 | `contracts/benchmark-manifest.json:598` |

**1142 introduces no new version requirement.** The PG15 column-list form is already
used by roughly 100 migration files. The earliest is
`0265_party_association_columns.sql`; `0770_set_null_fk_column_lists.sql` and
`0992_set_null_referential_actions_repair.sql` are dedicated to it, and all three are
sealed in `migrations/meta/_chain.sha256.json`. If the deployment target could not parse
this syntax, the chain would already be unreplayable.

Two things a deployer should still know:

1. The guarantee rests on a CI image tag and on environments that are documented rather
   than enforced. The cheap fix is a prerequisite line in the README and an assertion on
   `server_version_num >= 150000`. Neither exists today.
2. `migrations/0265_party_association_columns.sql:44` contains a **stale** comment
   claiming `ON DELETE SET NULL (column)` "needs Postgres 15, which this deployment does
   not pin". That was true in the Neon era. It is now contradicted by every migration
   from `0662a` onward. Do not treat it as current guidance. It is an applied, sealed
   migration, so under BE-60 the comment must not be edited in place.

## Journal integrity (BE-58, BE-59)

Measured over all 903 entries of `migrations/meta/_journal.json`:

- **903 `.sql` files, 903 journal entries, and the two sets are identical.** Zero files
  missing from the journal, zero journal entries without a file. BE-58 holds. (Files
  under `migrations/pending/` are a deliberate staging area outside the journal and are
  correctly excluded; `check:migration-rollback`'s self-test pins that exemption.)
- **`idx` is unique across all 903 entries.** Zero duplicates. BE-59's first half holds.
  `idx` is not contiguous — 128 values in the range are unused — which is expected:
  BE-59 forbids renumbering to close gaps.
- **`when` has exactly one non-increase in journal array order**, described below. Zero
  duplicate `when` values. Sorted by `idx`, `when` is strictly increasing with zero
  regressions.

## Alleged defect 1: duplicate migration prefix `1090` — REAL, already adjudicated

Both files exist:

| tag | idx | when | array position |
|---|---|---|---|
| `1090_subscription_purchases` | 716 | 1803000010168 | 718 |
| `1090_inv_quality_hold_stock_grain` | 847 | 1803000010299 | 847 |

They share a numeric prefix and nothing else: distinct tags, distinct `idx`, distinct
`when`, distinct files. **Nothing resolves a migration by numeric prefix.** The runner
reads `migrations/${entry.tag}.sql`; the seal is keyed by tag; the ledger
(`drizzle.__drizzle_migrations`) has no tag column at all and joins on `created_at`.

It is also not novel. This journal contains **80 duplicated numeric prefixes**, including
`0379` and `0540`–`0544` four and three ways respectively. They are the ordinary residue
of lanes numbering independently and then merging.

`check:migration-discipline` already carries `dup-prefix:1090_subscription_purchases.sql`
in `BASELINE_JOURNAL_INTEGRITY`, with a written rationale concluding that "both files
keep their names and the journal tag — not the numeric prefix — remains the identity
drizzle resolves." The gate passes with 0 new violations.

**Action: document, do not touch.** Renaming would require a letter suffix, and a letter
suffix is not a free "next available" name in this repo — it asserts a slot-between claim
that the gate's `[insert-order]` check then tests against the `when` of the next file in
filename order. Neither `1090`'s `when` sits in a window that would satisfy that.
More fundamentally, we cannot establish from here whether either file is applied
anywhere, and BE-60 forbids editing an applied migration's identity on a guess.

**One correction to the baseline's stated rationale, for the record.** It asserts that
`1090_inv_quality_hold_stock_grain` "arrived colliding with the already-sealed
`1090_subscription_purchases`". That premise is false against the current seal:
`_chain.sha256.json` was sealed 2026-09-04 with a high-water `when` of `1803000010136`,
and `1090_subscription_purchases` has `when 1803000010168`. **Neither 1090 is sealed.**
The conclusion still stands on the independent ground that the ledger stores no tag, but
the seal argument should not be relied on if this is revisited.

## Alleged defect 2: timestamp regression at `0619` / `0271` — REAL, already adjudicated

This is a real, single, well-understood condition, and the gate names it by exactly the
two migrations alleged. Journal array positions 338–342:

| array pos | idx | when | tag |
|---|---|---|---|
| 338 | 338 | 1787894609403 | `0617_cell_relocation_and_placement_decisions` |
| 339 | 339 | 1787895365277 | `0618_cell_capacity_measurements` |
| 340 | 717 | 1803000010169 | `0464a_gl_kernel` |
| 341 | 726 | **1803000010178** | `0271a_waitlist_admission` |
| 342 | 340 | **1787895425277** | `0619_chain_creates_what_production_has` |

Two cross-lane repair entries were spliced in at positions 340–341. Their `idx` and
`when` both place them late; only their array position is early. Crossing from 341 to 342
drops `when` by about 15.1 billion milliseconds. **This is the only `when` non-increase
in the entire journal.**

### Why it is harmless here, and precisely when it would stop being harmless

Ordering in this repository is **by journal array position**. `when` decides nothing.
`run-pending-migrations.mjs:128` builds its queue as
`journal.entries.map((e) => [e, e.when])` — the whole array, in order — and double
application is prevented by the file hash, not by a timestamp. `migration-plan.mjs`
partitions by **set membership** on `created_at`, not by a watermark.

The regression would become severe the instant any applier reverted to watermark
selection. Applying position 341 would set the watermark to `1803000010178`, and every
later entry carrying a `17…` timestamp — hundreds of them — would become permanently
unselectable, silently, with the run still reporting success. That is not hypothetical:
`run-pending-migrations.mjs` records that under the old filter, applying `0557` alone
made 15 later entries unselectable and `0559` cost another 17.

`check:watermark-free` is the gate that holds that door shut, and it passes: all five
appliers iterate the array and none selects by watermark.

**Action: document, do not touch.** Two independent reasons:

1. `0619_chain_creates_what_production_has` **is sealed**. Changing its `when` is a
   `RENUMBERED` failure in `check:migration-immutability`, which exists because `when` is
   the key every ledger row joins on.
2. `check:migration-discipline` already baselines
   `insert-order:0271a_waitlist_admission.sql`, annotated with the databases on which it
   is recorded as applied (`streamline_crm_merge`, `streamline_crm_e2e`,
   `crm_cold_0908`, plus a scratch). The baseline's own note states the rule:
   "check:migration-ledger joins on `when`, so moving it would orphan those rows. Hence
   baseline, not restamp."

Re-stamping a `when` without updating the matching ledger row is a known, previously
realised failure in this repository: it manufactures an orphan row and simultaneously
lifts the migration above the watermark, so a migration that demonstrably already ran is
reported as pending and the next `db:migrate` re-applies it. With no database reachable,
the ledger side of that repair cannot be performed, so the edit must not be made.

## What remains outstanding

1. **Apply 1141 and 1142.** BLOCKED. Requires a non-production PostgreSQL 15+ reachable
   via `DATABASE_URL`. None exists on this machine.
2. **Verify 1142's `confdelsetcols` actually contains `{headcount_id}`.** BLOCKED.
   Requires `SET_NULL_GATE_DATABASE_URL` or `pnpm check:composite-fk-set-null` against a
   bootstrapped non-production database, or a run of the `db-gates.yml` workflow.
3. **Order the deployment so 1141 precedes any write path that relies on
   `pm_workspace_id` being optional.** The schema and the published contract are already
   ahead of the database.
