# Pending migrations

Migrations in this folder are **authored, reviewed and reversible but deliberately
NOT registered** in `meta/_journal.json`, so `drizzle-kit migrate` will not run them.

They live here instead of alongside the applied migrations so that the invariant
`count(migrations/*.sql) == count(journal entries)` stays true — a mismatch there
means real drift and should be investigated, not shrugged at.

Each file documents the preconditions that must be satisfied before it is moved up
into `migrations/` and registered.

## The rule this directory has broken twice, and the one thing it must not do

**Nothing under `migrations/pending/` may be the only creator of an object that
`src/db/schema/**` declares.** A `.sql` here never runs — `db:migrate` skips it and
still prints success — so a Drizzle declaration that names such an object is a
promise about the live database that nothing keeps.

The instance that made this rule: `uniq_hr_people_org_person_link` is declared at
`src/db/schema/hr/core-people.ts:85` and, until migration `1048`, the only SQL
creating it was `hrms-phase1/0000_hrms_profiles_workforce.sql`. Two consequences,
and the second is the one that hides:

1. Nothing stopped two `hr_people` rows pointing at the same directory person in
   one organisation.
2. Five sites branch on `code === "23505" && constraint ===
   "uniq_hr_people_org_person_link"` — `hr-people.service.ts:172`,
   `recruitment-handoff.service.ts:141/164/179`,
   `hr-import-commit.service.ts:142`. Every one was unreachable, because the
   constraint they name did not exist. Code that LOOKS like it handles a
   duplicate handled nothing.

Measured on a database bootstrapped to journal head (2026-09-03): **66 declared
constraints, indexes, foreign keys and checks are created only by a file in this
directory** — 34 by `hrms-phase1/0000`, 15 by `hrms-phase1/0001`, 6 by
`hrms-phase1/0004`, 10 by the `hrms-lifecycle-concurrency` bundle and 1 by
`hr-audit-cursor/0400`. They sit on `worker_engagements` (21), `hr_employments`
(9), `workers` (8), `organization_people` (6), `org_units` (6), `hr_people` (5)
and nine other tables — every one of which IS in the runtime Drizzle barrel.

Two ways out, and which one applies depends on the table:

- **The table is in the runtime barrel** (`db/schema/index.ts`): the object needs
  its own journalled migration, the way `1048` extracted
  `uniq_hr_people_org_person_link` out of `hrms-phase1/0000`. The bundle keeps its
  copy; `CREATE … IF NOT EXISTS` makes the pair idempotent.
- **The table is genuinely SQL-managed**: it belongs in
  `db/schema/hrms-phase1-sql-managed.ts`, which is deliberately outside the runtime
  barrel so Drizzle never generates DDL for it, and
  `src/db/migration-integrity.spec.ts` pins that arrangement. Being unimported is
  the design.

`pnpm check:declaration-constraint-drift` is the gate. It compares every declared
unique, index, foreign key and check against `pg_constraint`/`pg_index` on a
database at journal head and fails on anything not in its baseline. Nothing
static can see this class: the columns are present and correctly typed on both
sides, so `check:declaration-column-drift` reads clean over it.

## Inventory

`hrms-phase1` and `hrms-relational-normalization` are **not** "move up and
register" candidates. They are delivered by the hash-allowlisted HRMS bundle
runner, not by `drizzle-kit migrate`, and `migration-integrity.spec.ts` asserts
that their five forward files never appear in `meta/_journal.json`. Registering
them fails that spec. Their own `README.md` carries the execution contract.

| File | Kind | Blocked on |
|---|---|---|
| `0373_build_money_contract.sql` (+ `.down`) | move up and register | Removing the two remaining legacy-column dual-writes in `projects-budget.service.ts:160` and `projects-provision.service.ts:167`. |
| `0380_subscription_status_suspended.sql` (+ `.down`) | move up and register | The dunning wave; `0380`–`0382` apply as one ordered set. |
| `0381_dunning_attempts_table.sql` (+ `.down`) | move up and register | Same wave as `0380`. |
| `0382_dunning_attempts_backfill.sql` (+ `.down`) | move up and register | Same wave as `0380`; runs after `0381`. |
| `0827_kb_chunk_search_iterative_scan.WITHDRAWN.sql` | withdrawn | Kept as the record of a rejected approach. Never register it; the `.WITHDRAWN` infix is what stops a numeric-prefix sweep picking it up. |
| `hr-audit-cursor/0400_hr_audit_cursor_index.*` | move up and register | `CREATE INDEX CONCURRENTLY` cannot run inside `drizzle-kit migrate`'s transaction, so this bundle needs an out-of-transaction runner or a non-concurrent rewrite. See its `README.md`. **Declares `idx_hr_audit_logs_org_created_id`, which `hr_audit_logs` in the runtime barrel names.** |
| `hr-export/0399_hr_export_jobs.*` | move up and register | Private object storage configured and tenant-scoped; worker stays disabled through the additive migration. See its `README.md`. |
| `hrms-lifecycle-concurrency/000{0,1,2}_*` | bundle runner | Rehearsal on a production-size clone. **Contributes 10 objects that the runtime barrel declares** — see the rule above. |
| `hrms-phase1/000{0..4}_*` (+ `.down`, + `preflight/`) | bundle runner, never journalled | Approval of the schema decisions does not authorize execution; see its `README.md`. Pinned out of the journal by `migration-integrity.spec.ts`. **Contributes 55 objects that the runtime barrel declares.** |
| `hrms-relational-normalization/*` | bundle runner | Review-only; never run against any database. See its `README.md`. |
