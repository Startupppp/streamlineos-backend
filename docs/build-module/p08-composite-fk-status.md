# P0 #8 — tenant-safe composite FKs and parent-child 404s

Status as of 2026-09-22, branch `build/final-o-p08`.

| Half | Status |
| --- | --- |
| Parent-child 404 behaviour | **DONE** — verified by running |
| Composite FK — declaration | **DONE** — verified by running |
| Composite FK — migration text | **DONE** — new gate, verified by running |
| Composite FK — **database catalog** | **BLOCKED** — no non-production database exists |

Database verification is BLOCKED, not DONE. Nothing below changes that.

---

## 1. What ran

Every command was run in `D:/projects/personal/slos-be-o-p08`. Self-tests first:
a gate that resolves nothing reports zero vacuously.

### Self-tests

| Command | Result |
| --- | --- |
| `pnpm check:composite-fk-set-null:self-test` | `7/7 passed` — exit 0 |
| `pnpm check:set-null-column-lists:self-test` | `check-set-null-column-lists self-tests: 14 passed` — exit 0 |
| `pnpm check:migration-immutability:self-test` | `13 passed` — exit 0 |
| `pnpm check:migration-rollback:self-test` | `9 passed, 0 failed` / `SELF-TEST PASSED` — exit 0 |
| `pnpm check:drop-column-safety:self-test` | 10 checks / `SELF-TEST PASSED` — exit 0 |
| `pnpm check:migration-discipline:self-test` | `27 passed, 0 failed` — exit 0 |
| `pnpm check:db-generate-guard:self-test` | `"pass": true`, 6 checks — exit 0 |
| `pnpm check:watermark-free:self-test` | `10 checks, both directions bite` — exit 0 |
| `pnpm check:gate-wiring:self-test` | `28 passed` — exit 0 |
| `pnpm check:set-null-migration-text:self-test` | `40 passed` — exit 0 (new) |

### Gates

```
$ pnpm check:set-null-column-lists
Declared SET NULL foreign keys 606  ·  requiring a column list 286  ·  unreachable 0
Declaration half OK — every declared SET NULL key has at least one nullable member.
INCONCLUSIVE — the catalog half did not run. The ON DELETE SET NULL column list lives
only in pg_constraint.confdelsetcols; nothing static can see it, so 286 constraint(s)
are UNVERIFIED.
  Set SET_NULL_GATE_DATABASE_URL to a bootstrapped database to run it.
exit 2
```

```
$ pnpm check:migration-immutability
OK — every sealed migration still builds the same database.                     exit 0

$ pnpm check:migration-rollback
check:migration-rollback PASSED · 903 migrations scanned                        exit 0

$ pnpm check:drop-column-safety
903 migration file(s), 134 dropped column(s), 413 schema file(s)
  OK — no dropped column is still declared in the Drizzle schema                exit 0

$ pnpm check:migration-discipline
check:migration-discipline PASSED · 903 SQL files checked, 0 new violations     exit 0

$ pnpm check:db-generate-guard
903 journal entries, latest snapshot 0464, real drift 438 — db:generate is BLOCKED
without ALLOW_DB_GENERATE=1.                                                    exit 0

$ pnpm check:watermark-free
OK — 5 migration applier(s) iterate the journal and guard double application;
none selects by watermark.                                                      exit 0

$ pnpm typecheck
exit 0

$ npx eslint src/scripts/check-set-null-migration-text.ts
exit 0
```

`pnpm check:gate-wiring` exits 1 on two **pre-existing** unwired gates,
`check:build-authz-census` and `check:build-authz-census:check`. Both are present in
`package.json` at HEAD and are not part of this change. Before the new gate was wired
into `ci.yml` the count was 3; it is now back to the pre-existing 2.

### Tests

```
$ pnpm jest src/modules/build/build-project-scoped-lists-404.spec.ts \
            src/modules/build/core/project-access-404.spec.ts
Test Suites: 2 passed, 2 total
Tests:       22 passed, 22 total        (18 + 4)

$ pnpm jest src/modules/build --silent
Test Suites: 195 passed, 195 total
Tests:       1442 passed, 1442 total
Time:        63.387 s
```

Exactly the 195/1442 baseline. No new failures. Parent-child 404 behaviour still holds
after the authorization work.

---

## 2. What is BLOCKED, and on exactly what

**`check:set-null-column-lists` — catalog half.**

Exact external requirement: *a non-production, bootstrapped PostgreSQL 15 or later,
migrated to journal head, reachable via `SET_NULL_GATE_DATABASE_URL`.*

No such database exists:

- `backend/.env` points at production Aurora and its credentials are rejected (`28P01`).
- `D:/localstack` was deleted.
- This worktree has no `.env` at all — `check:composite-fk-set-null:self-test` printed
  `injected env (0) from .env`, confirming zero variables were loaded here. The
  `.env` hazard is specific to `D:/projects/personal/Streamlineos/backend/.env`
  (12,265 bytes, present).

**`pnpm check:composite-fk-set-null` (the main gate) was NOT run.** It calls
`dotenv.config()` on `<backend>/.env` at module load (line 36) and then opens a live
connection (line 133). Its `--self-test` *was* run and is safe: `main()` returns at
line 119, before the `postgres(url)` call. Verified by reading, then by running —
7/7 passed, no connection attempted.

Also not run, per the standing prohibition: `db:migrate`, `db:push`, `db:generate`,
`migration:proof*`, `check:migration-chain`, `check:migration-ledger`,
`db:verify-rls`, `openapi:generate`.

**The unblock path already exists.** `.github/workflows/db-gates.yml:157` runs

```yaml
- name: ON DELETE SET NULL column lists (catalog half)
  run: pnpm check:set-null-column-lists
  env:
    SET_NULL_GATE_DATABASE_URL: postgres://ci:ci@127.0.0.1:5432/ci
```

against the job's own `pgvector/pgvector:pg16` service. The same file also runs
`check:composite-fk-set-null` with `DATABASE_URL` pointed at that service. Neither
needs any new infrastructure — they need that workflow to run.

---

## 3. The 286 unverified constraints

### Which 286 they are

Not a list to be maintained — a rule, and it is exact. Derived from
`deriveSetNullDeclarations(schema)`:

- **All 286 are arity 2.** No arity-3 or higher key requires a column list.
- **Member 0 is always the NOT NULL tenant column**: `org_id` on 281,
  `organization_id` on 5. True for 286 of 286.
- **Member 1 is always the single nullable pointer.** `setNullColumns.length === 1`
  for 286 of 286.

So the rule is: *every declared `ON DELETE SET NULL` foreign key of the shape
`(tenant_col NOT NULL, pointer NULL)`* — and the required column list is always exactly
`ON DELETE SET NULL (<pointer>)`, fully determined by the declaration.

Spread: 177 distinct child tables — `public` 231, `build` 53, `build_events` 2. The
heaviest are `payroll_runs` (10), `payroll_journal_batches` (8), `kb_pages` (7),
`build.bugs` (6), `build.tickets` (5), `leave_requests` (5).

The 5 `organization_id` keys, in full:

```
public.portal_invitations.fk_portal_invitations_inviter_membership_id_org  -> (inviter_membership_id)
public.portal_memberships.fk_portal_memberships_user_membership           -> (user_membership_id)
public.worker_engagements.fk_worker_engagements_created_actor             -> (created_by_membership_id)
public.worker_engagements.fk_worker_engagements_org_job_level             -> (job_level_id)
public.worker_engagements.fk_worker_engagements_org_job_role              -> (job_role_id)
```

The other 320 of the 606 declared SET NULL keys have every member nullable, so a bare
`ON DELETE SET NULL` is already correct for them and no column list is required.

### What a wrong column list actually does

Three distinct outcomes, and only one of them is data corruption.

**(a) No column list — the common defect.** Postgres's bare `ON DELETE SET NULL` nulls
*every* column of the key. On `(org_id, pointer_id)` the parent delete emits

```sql
UPDATE ONLY <child> SET "org_id" = NULL, "pointer_id" = NULL WHERE ...
```

`org_id` is NOT NULL, so the statement aborts with **23502 on the child table** and the
parent `DELETE` fails. The constraint can never once perform the action it declares.

This is **not** data corruption. It is a hard, loud failure — and the danger is *where*
it fires. Parents here are normally soft-deleted (`deleted_at`), so ordinary product
traffic never reaches it. The one path that does a hard delete is DPDP/GDPR erasure.
So the failure mode is: erasure requests fail, in the one place a hard delete is legally
required, and nowhere else. Measured and recorded in `0662a`'s header:

```
ERROR: null value in column "org_id" of relation "crm_contact_channel_consent"
       violates not-null constraint
```

**(b) A column list naming the NOT NULL tenant column** — `SET NULL (org_id)`.
Identical to (a): 23502, parent delete aborts. Caught by the same predicate, because
`UNREACHABLE_SET_NULL_QUERY` tests `COALESCE(confdelsetcols, conkey)`.

**(c) A column list naming the wrong *nullable* column.** This is the only shape that
corrupts. `SET NULL (some_other_nullable_id)` succeeds silently: the delete nulls a
column that has nothing to do with the deleted parent, leaves `pointer_id` dangling at
a row that no longer exists, and reports success. Nothing raises. It would surface later
as a broken join or a phantom reference.

Shape (c) is **structurally unreachable for all 286** as long as the declaration is the
source of truth, because each of the 286 has exactly one nullable member — there is no
*other* nullable column in the key to name by mistake. A wrong list on these 286 can
only be shape (b), which fails loudly.

### Therefore: the real risk of leaving them unverified

Low, and bounded — but non-zero, and not zero-cost.

- The realistic failure is **(a)/(b): a loud 23502 that blocks DPDP/GDPR erasure**, not
  silent cross-tenant data corruption. Tenant isolation is not at stake: `org_id` is
  NOT NULL and the defect *prevents* it being nulled rather than allowing it.
- Silent corruption (c) is structurally impossible across all 286 given single-nullable-
  member keys.
- The blast radius is the erasure path only; normal reads and writes are unaffected,
  which is precisely why the class survived from 0272/0275 to 0662 unnoticed.

The residual risk is not the 286 as a set — it is that nothing static could see *any*
of them. Section 4 closes most of that.

---

## 4. What turned out to be statically knowable

### The declaration is genuinely silent — confirmed

`src/db/schema/hr/requisitions.ts:37`:

```ts
foreignKey({ columns: [table.orgId, table.headcountId], ... }).onDelete("set null"),
```

And the installed Drizzle type, `node_modules/drizzle-orm/pg-core/foreign-keys.d.ts`:

```ts
export type UpdateDeleteAction = 'cascade' | 'restrict' | 'no action' | 'set null' | 'set default';
onDelete(action: UpdateDeleteAction): this;
```

A single string union. **There is no parameter for a column list.** The schema cannot
express what migration 1142 changes. Confirmed by reading the type declaration, not
inferred from usage.

### But the migration SQL is not silent — a partial static check IS possible

`ON DELETE SET NULL ("headcount_id")` is ordinary text in `migrations/*.sql`, and the
corpus is the only thing that installs these constraints. 285 of the 286 constraint
names appear literally in migration text.

Shipped: **`src/scripts/check-set-null-migration-text.ts`**, wired as
`check:set-null-migration-text` (+ `:self-test`, `:report`) and added to `ci.yml` as a
hermetic step. It opens no connection and needs no database.

It replays the corpus in journal order and reads the installed column list out of the
DDL. Current output:

```
Migration files 903  ·  keys requiring a column list 286  ·  resolved to an install 283
Catalog-driven sweeps 2 (0770_set_null_fk_column_lists, 0992_set_null_referential_actions_repair)
  — text is authoritative only after journal position 639
  installed 246 · swept 33 · bare 2 · drift 0 · not-set-null 2 · dropped 2 · untraceable 1
OK — 246 ... installed with the required column list, 2 known bare, 0 new.
exit 0
```

**246 of the 286 are now statically verified.** They were UNVERIFIED before.

Getting this right required four corpus facts that a naive text scan gets wrong. Each is
pinned by a self-test:

1. **Journal order is not filename order.** `0662a_composite_fk_set_null_nulls_tenant`
   is journal entry **824**; `0576_tenant_fks_public_a` is **839**. The repair applies
   *before* the file whose name reads 86 lower. Replaying by filename inverts them.
2. **Guarded adds, idiom one.** 2,721 adds across 58 files sit inside
   `IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '…')`. A guarded add over
   an existing constraint is dead text. Treating it as an install produced **88** false
   violations.
3. **Guarded adds, idiom two.** 333 adds across 55 files use
   `DO $$ BEGIN ALTER TABLE … ADD CONSTRAINT …; EXCEPTION WHEN duplicate_object THEN NULL; END $$`.
   Semantically the same guard, textually nothing like it. Missing it produced **9**
   further false violations.
4. **Two catalog-driven sweeps repair by name, and name nothing.** `0770` (journal 465)
   and `0992` (journal 639) loop over `pg_constraint` and issue `EXECUTE format(...)`.
   No text scan can attribute their work. What they *do* leave in the text is a proof
   obligation: each ends with a `COUNT` over the remaining defects and
   `RAISE EXCEPTION` if any survive. `0992`'s terminal predicate is
   `UNREACHABLE_SET_NULL_QUERY` verbatim — `COALESCE(con.confdelsetcols, con.conkey)`
   over `attnotnull` — covering the bare form and the stale-column-list form at any
   arity. So the corpus is authoritative only *after* journal position 639; before it,
   the sweep is. 33 keys are accounted for this way and marked `swept`, not `installed`.

The sweeps are detected, not hardcoded, and the self-test asserts that at least two
exist, that the last is `0992`, and that its terminal predicate still contains
`COALESCE(con.confdelsetcols, con.conkey)`. If a refactor rewrites them, the gate fails
rather than silently declaring every pre-sweep key `swept`.

### Two genuine defects found, statically

Both are installed **after** the last sweep (journal 639), so nothing repairs them, and
both are reachable — their guards do not fire because nothing else in the corpus creates
the constraint:

| Constraint | Table | Installed by | Required repair |
| --- | --- | --- | --- |
| `fk_inv_sales_orders_channel_id_org` | `public.inv_sales_orders` | `0580a_inventory_channel_pools` (journal 806) | `ON DELETE SET NULL (channel_id)` |
| `fk_inv_stock_adjustments_scrap_location_id_org` | `public.inv_stock_adjustments` | `0545a_stock_write_off` (journal 787) | `ON DELETE SET NULL (scrap_location_id)` |

Both carry a bare `ON DELETE SET NULL` over `(org_id NOT NULL, <nullable pointer>)`.
Verified: `org_id.notNull === true` and the pointer `notNull === false` on both tables;
neither table is ever dropped; no migration after journal position 681 mentions
`confdelsetcols` at all, so no later sweep reaches them.

On a fresh bootstrap from the journal, deleting an `inv_channels` or `inv_locations`
parent row raises 23502. **`db-gates.yml` should currently be red on exactly these two**
— that workflow's `check:composite-fk-set-null` step was only added 2026-09-21 and, per
its own inline comment, the gate "had never run".

They are recorded in a named `KNOWN_BARE` ledger in the gate, printed on every run, with
the repair SQL. A stale entry is a **failure**, not a pass — the same rule
`KNOWN_UNFIXED` carries in `check-composite-fk-set-null.mjs`. Writing the repair
migration is not part of this change: it cannot be verified without a database, and
`1142` is itself still unapplied.

### Four things the gate reports rather than counts as clean

- **2 declaration divergences** — the schema declares SET NULL, the corpus installs
  something else. `calendar_events.fk_calendar_events_linked_lead_party_id` gets
  NO ACTION from `0662a` (its deliberate erasure-path repair; `src/db/schema` was never
  touched), and `payroll_run_employees.fk_payroll_run_employees_org_worker` gets
  RESTRICT from `0392` (journal 119). These are printed because the **catalog half
  skips them silently**: `check-set-null-column-lists.ts:304` does
  `if (row === undefined) continue;`, and a constraint whose `confdeltype` is not `'n'`
  never appears in the column-set map.
- **2 dropped** — `invitations.fk_invitations_org_inviter_membership` and
  `…_accepted_membership`, dropped by `0982_ar02_drop_live_duplicate_composites`
  (journal 623) as duplicate composites, "keeping the member that carries the
  referential action". Deliberate; the referential action survives under another name.
- **1 untraceable** —
  `build.managed_products.managed_products_org_id_owner_membership_id_organization_members_org_id_id_fk`
  is **77 characters**. Postgres truncates identifiers at 63 bytes, so the catalog
  carries `managed_products_org_id_owner_membership_id_organization_member`. The new
  gate matches the truncated form; it appears only in drizzle meta snapshots, never in
  an applied `.sql`.

  **This is also a live blind spot in the existing catalog half.** It keys on
  `fk.getName()` — the untruncated 77-char name — so `byConstraint.get(key)` misses,
  and `check-set-null-column-lists.ts:304` silently `continue`s. Even *with* a database,
  that constraint is not checked. Not fixed here; recorded.

### Mutation proof

The gate was proved to bite, then every mutation reverted byte-exactly
(`md5sum` re-verified, `git status --short migrations/` clean):

| Mutation | Result |
| --- | --- |
| Strip the column list from **migration 1142** (the P0 #8 migration, journal 902) | `FAIL — 1 … public.job_requisitions.fk_job_requisitions_headcount_org … requires: ON DELETE SET NULL (headcount_id)` — exit 1 |
| Change 1142's list to `("org_id")`, the NOT NULL tenant column | `drift 1` · `installs: ON DELETE SET NULL (org_id)` / `requires: … (headcount_id)` — exit 1 |
| Repair `0545a`'s text so the ledger entry goes stale | `STALE fk_inv_stock_adjustments_scrap_location_id_org is in KNOWN_BARE but the corpus no longer installs it bare` — exit 1; the **self-test also failed**: `KNOWN_BARE entry … is still installed bare by the corpus (found "installed")` |
| Remove a `KNOWN_BARE` entry | that key is reported as a new violation — exit 1 |

The first mutation is the load-bearing one: **the gate statically verifies that migration
1142 is correct**, even though 1142 is unapplied and no database exists to check it
against.

---

## 5. What is still BLOCKED after all of this

The new gate narrows the unverified set. It does not empty it, and it is not a
substitute for the catalog half.

Statically unknowable, by construction:

- whether a migration was **actually applied** — 1142 is journalled and unapplied;
- whether a migration was **partially executed**;
- whether a constraint was **altered out of band**, which `0619` records happening;
- the **40 of 286** the text cannot settle: 33 `swept` (correct only if 0770/0992 truly
  applied — their own `RAISE EXCEPTION` proves it *if* they ran), 2 known bare, 2
  divergent, 2 dropped, 1 untruncatable-name.

Only `pnpm check:set-null-column-lists` with `SET_NULL_GATE_DATABASE_URL` against a
bootstrapped non-production database settles those. That database does not exist on this
machine, and `backend/.env` points at production with credentials that are rejected
(`28P01`).

**Database verification status: BLOCKED.**

---

## 6. Evidence classification

- **Verified by running**: all self-tests and gates in §1; both jest suites; typecheck;
  eslint; the four mutation proofs; the 286-constraint shape analysis (derived by
  executing `deriveSetNullDeclarations` against the real schema); the journal-position
  facts; the `org_id` / pointer nullability of the two defective tables.
- **Verified by reading**: that `check:composite-fk-set-null`'s `--self-test` opens no
  connection (returns at line 119, before `postgres(url)` at line 133); that
  `check:gate-wiring` performs no DB I/O (imports only `node:child_process`, `node:fs`,
  `node:path`, `node:url`, `yaml`; its single `execFileSync` is a read-only
  `git for-each-ref`); that Drizzle's `onDelete` takes no column list
  (`UpdateDeleteAction` is a five-member string union); that `0770` and `0992` assert
  their own fixpoints before committing; that `check-set-null-column-lists.ts:304`
  silently skips constraints absent from the catalog map.
- **Blocked**: every claim about the live catalog.
