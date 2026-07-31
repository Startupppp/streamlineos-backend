# Pending migrations

Migrations in this folder are **authored, reviewed and reversible but deliberately
NOT registered** in `meta/_journal.json`, so `drizzle-kit migrate` will not run them.

They live here instead of alongside the applied migrations so that the invariant
`count(migrations/*.sql) == count(journal entries)` stays true — a mismatch there
means real drift and should be investigated, not shrugged at.

Each file documents the preconditions that must be satisfied before it is moved up
into `migrations/` and registered.

| File | Blocked on |
|---|---|
| `0373_build_money_contract.sql` | Removing the two remaining legacy-column dual-writes in `projects-budget.service.ts:160` and `projects-provision.service.ts:167`. |
