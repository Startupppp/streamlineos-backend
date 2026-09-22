# Migration chain — re-verification and repair specification

**Date:** 2026-09-22 · **Branch:** `build/final-p-chain` · **Worktree:** `slos-be-p-chain`

> **NO DATABASE WAS CONTACTED.** This worktree has no `.env` (only `.env.example`) and
> `DATABASE_URL` is unset. Every statement below is verified by running a static gate or
> by reading source. Migrations **1141 and 1142 remain UNAPPLIED**. No repair described
> here has been executed; the two defects are documented, not touched.

Supersedes the analysis in `docs/migration-static-verification-2026-09-21.md` where the
two disagree. Four of that document's conclusions are corrected below.

## Summary

| Item | Verdict |
|---|---|
| Journal integrity (903/903, unique `idx`, one `when` non-increase) | **Confirmed**, independently re-measured |
| Seal facts (0619 sealed; 0271a/0464a/both 1090s/1141/1142 not) | **Confirmed** by the `tag` inside each seal entry |
| Duplicate prefix `1090` | Real. **CORRECTION: it is the only un-baselined collision, not "one of 80"** |
| `when` regression at `0271a → 0619` | Real. **CORRECTION: `check:migration-discipline` cannot fail on it at all** |
| `check:migration-chain` | **CORRECTION: it is RED on exactly these two defects, and it runs in CI** |
| 1141 / 1142 well-formed, journalled, reversible | Confirmed |
| `23502` deployment hazard | **CORRECTED — not reachable. The real hazard is different** |
| PostgreSQL floor | Confirmed undeclared |

---

## 1. Facts re-established independently

Measured directly from `migrations/meta/_journal.json` and the `migrations/` directory,
not by rerunning the prior pass's script:

- 903 `.sql` files, 903 journal entries, the two sets identical — 0 unjournalled, 0 fileless.
- `idx` unique across all 903. Range 0–1030 with 128 unused values (gaps are mandated by
  BE-59, which forbids renumbering to close them).
- `when` unique across all 903. Zero duplicates.
- Exactly **one** `when` non-increase in journal array order, at array position 342.
- Sorted by `idx` instead of array position, `when` is strictly increasing with **zero**
  regressions. The regression is purely an artifact of array placement.

### Seal membership

`migrations/meta/_chain.sha256.json` keys its 685 entries by **array index string**
(`"0"`…`"684"`); each entry carries its own `tag`. The authoritative membership test is
that inner `tag` — comparing tags against the index keys, or against current journal
positions, gives wrong answers, because `0464a` and `0271a` were spliced in after the
2026-09-04 seal. Resolving all 685 inner tags:

| tag | sealed? |
|---|---|
| `0619_chain_creates_what_production_has` | **SEALED** |
| `0271a_waitlist_admission` | not sealed |
| `0464a_gl_kernel` | not sealed |
| `1090_subscription_purchases` | not sealed |
| `1090_inv_quality_hold_stock_grain` | not sealed |
| `1141_projects_pm_workspace_optional` | not sealed |
| `1142_fix_requisition_headcount_fk_set_null` | not sealed |
| `0333_pm_workspace_id_not_null` | SEALED |
| `0265_party_association_columns` | SEALED |

Seal high-water `when` = `1803000010136`, `sealedAt` = 2026-09-04.

**The prior pass's correction is upheld.** The `BASELINE_JOURNAL_INTEGRITY` rationale in
`src/scripts/check-migration-discipline.mjs:332` claims `1090_inv_quality_hold_stock_grain`
"arrived colliding with the already-sealed `1090_subscription_purchases`". Neither 1090 is
sealed — `1090_subscription_purchases` has `when 1803000010168`, above the high-water mark.

**A second false premise in the same rationale, not previously named.** It continues:
"renaming a sealed migration would break its hash". It would not.
`src/scripts/verify-migration-chain.mjs:60-66` records the correction, made 2026-09-10:
all appliers hash the **file content** and nothing else, the tag never enters the hash, and
`drizzle.__drizzle_migrations` stores only `(id, hash, created_at)`. Confirmed at
`run-pending-migrations.mjs:73,86` — the applied test is `where hash = $1`. **Renaming is
hash-safe.** The discipline gate's rationale rests on two premises that are both false; the
conclusion survives only on the third, reference-based ground given in §3.

---

## 2. The decisive finding: `check:migration-chain` is RED on both defects

Both gates define a "numeric prefix" as the first underscore-delimited segment, so a letter
suffix makes a distinct key (`0540` ≠ `0540a`). Under that definition there are **15**
prefix collisions, not 80. The figure 80 comes from a looser reading — leading digits with
the letter discarded — that no gate uses.

`verify-migration-chain.mjs` baselines 14 of the 15 in `HISTORICAL_DUPLICATE_PREFIXES`
(`0300 0370 0371 0372 0374 0375 0379 0420 0426 0430 0431 0432 0700 0701`). There are zero
stale entries in that set. **`1090` is the one collision it does not baseline.**

`HISTORICAL_TIMESTAMP_REGRESSIONS` carries 16 exact pairs. It contains
`0271a_waitlist_admission -> 0269_mailbox_push_secret`. It does **not** contain
`0271a_waitlist_admission -> 0619_chain_creates_what_production_has` — the one pair that
exists in the current journal.

Replaying the gate's own `runChecks()` logic against the current tree with
`appliedWatermark = null` (checks a–e; `.chain-gaps` is absent so (e) is skipped) yields
exactly two failures and nothing else:

```
(b) DUPLICATE PREFIX 1090: 1090_inv_quality_hold_stock_grain, 1090_subscription_purchases
(c) TIMESTAMP REGRESSION 0619_chain_creates_what_production_has (1787895425277)
    <= 0271a_waitlist_admission (1803000010178)
```

`main()` sets `process.exitCode = 1` on any failure. `.github/workflows/ci.yml:643` runs
`pnpm check:migration-chain:self-test && pnpm check:migration-chain` in the `gates` job —
`runs-on: ubuntu-latest`, no `services:`, no `DATABASE_URL`, and `.env` is gitignored
(`.gitignore:5`), so check (f) skips and checks (a)–(e) decide the exit. The self-test
passes 24/24, so the gate is not vacuous.

`src/scripts/verify-migration-chain.mjs`, `check-migration-discipline.mjs` and
`migrations/meta/_journal.json` are byte-identical to `main` in this worktree, so this is
not a branch artifact.

**These two defects are not merely "documented and tolerated". They are the live cause of a
failing required CI step**, and the baselines were never extended when
`1090_inv_quality_hold_stock_grain` arrived — both the file and the last edit to the chain
script come from the same merge, `2697cd5b1`.

### Why `check:migration-discipline` disagrees

It does not disagree; it structurally cannot fail on defect 2.
`check-migration-discipline.mjs:752`:

```js
if (v.label === "journal-order") { notes.push(v); continue; }
```

`journal-order` findings are unconditionally downgraded to NOTEs **before** the baseline is
consulted, so the gate can never fail on a `when` regression — baselined or not. The ~60
`journal-order:` entries in `BASELINE_JOURNAL_INTEGRITY` suppress printing only; they carry
no enforcement. `insert-order` and `dup-prefix` are real violation labels, and `1090` *is*
baselined there, which is why that gate reports "0 new violations".

So the enforcement picture is the inverse of what the baseline comments imply:

| defect | `check:migration-discipline` | `check:migration-chain` |
|---|---|---|
| dup prefix `1090` | baselined → green | **not baselined → FAILS** |
| `when` regression | downgraded to NOTE → can never fail | **not baselined → FAILS** |

---

## 3. Defect 1 — duplicate prefix `1090`

| tag | idx | when | array pos | sealed |
|---|---|---|---|---|
| `1090_subscription_purchases` | 716 | 1803000010168 | 718 | no |
| `1090_inv_quality_hold_stock_grain` | 847 | 1803000010299 | 847 | no |

Distinct tags, `idx`, `when` and files. Nothing resolves a migration by numeric prefix: the
runner reads `migrations/${entry.tag}.sql`, the seal keys on the tag inside each entry, and
the ledger has no tag column at all. The defect is a **gate failure**, not a runtime one.

### The correct repair

Rename the later arrival and its journal tag:

```
git mv migrations/1090_inv_quality_hold_stock_grain.sql \
       migrations/1090a_inv_quality_hold_stock_grain.sql
git mv migrations/rollback/1090_inv_quality_hold_stock_grain.down.sql \
       migrations/rollback/1090a_inv_quality_hold_stock_grain.down.sql   # if present
```

and in `migrations/meta/_journal.json`, at array position 847, change only the `tag`:

```json
{ "idx": 847, "version": "7", "when": 1803000010299,
  "tag": "1090a_inv_quality_hold_stock_grain", "breakpoints": true }
```

Leave `idx`, `when`, `breakpoints` and the array position untouched. Do not edit the file
body — that is what BE-60 protects, and it is untouched by a rename.

**Simulated in memory against both gates' real logic. All four post-conditions hold:**

- `check:migration-discipline` dup-prefix: 14 collisions remain, all baselined; none is `1090`.
- `check:migration-chain` check (b): **0** un-baselined collisions.
- `check:migration-discipline` insert-order for the new letter-suffixed name **passes**:
  base `1090_subscription_purchases` `when 1803000010168` < own `1803000010299` < next
  `1091_inv_projects_rls` `when 1803000010300`. The window is one millisecond wide and the
  entry already sits inside it — no restamp is needed.
- Journal array position stays 847, so replay order does not move.

### Why it is safe without a ledger, and the one thing that is not

The rename is **hash-safe**: appliers match on content hash, the tag never enters the hash,
and the ledger stores no tag. A database that already has this migration still matches by
hash and skips it. Neither 1090 is sealed, so `check:migration-immutability` is unaffected.

The residual risk is **reference**, not correctness, and it is exactly the asymmetry
`verify-migration-chain.mjs:70-74` states as policy: an applied tag is quoted in runbooks,
in `db:apply-one --tag=`, in rollback manifests and in cross-session notes, and renaming it
silently invalidates all of them. We cannot establish from here whether
`1090_inv_quality_hold_stock_grain` has been applied anywhere, because that requires reading
a ledger.

**Verdict: do not execute now.** Not because the repair is wrong — it is verified correct —
but because its one precondition (the tag is not yet referenced anywhere) is unprovable
without a database. Two acceptable resolutions, in preference order:

1. **Preferred.** Confirm from each known ledger that the tag is unapplied, then rename. The
   set to check is the one the discipline gate already annotates for its neighbours:
   `streamline_crm_merge`, `streamline_crm_e2e`, `crm_cold_0908`, the Neon branch, and the
   inventory ledgers.
2. **Fallback, if it is applied somewhere.** Keep both names and add `"1090"` to
   `HISTORICAL_DUPLICATE_PREFIXES` in `verify-migration-chain.mjs`, matching the entry the
   discipline gate already carries. This turns CI green and is the honest record of a
   collision that has become load-bearing. It requires an explicit override of that set's
   CLOSED policy, and the comment added must say so.

Either way, correct the `BASELINE_JOURNAL_INTEGRITY` rationale at
`check-migration-discipline.mjs:332`, which currently justifies the baseline with two false
premises (see §1).

---

## 4. Defect 2 — `when` regression at array position 342

| array pos | idx | when | tag | sealed |
|---|---|---|---|---|
| 339 | 339 | 1787895365277 | `0618_cell_capacity_measurements` | yes |
| 340 | 717 | 1803000010169 | `0464a_gl_kernel` | no |
| 341 | 726 | **1803000010178** | `0271a_waitlist_admission` | no |
| 342 | 340 | **1787895425277** | `0619_chain_creates_what_production_has` | **yes** |

Two cross-lane repairs were spliced in at 340–341. Their `idx` and `when` place them late;
only their array position is early. Crossing 341→342 drops `when` by ~15.1 billion ms.

### Blast radius, measured

Ordering is by array position. `run-pending-migrations.mjs:128` queues
`journal.entries.map((e) => [e, e.when])` — the whole array, in order — and double
application is prevented by the hash guard at line 73, not by a timestamp. The watermark is
computed at line 100 and, per the comment block at 110–128, "decides nothing".

If any applier reverted to watermark selection and applied through position 341, the
watermark would become `1803000010178` and every later entry at or below it would become
permanently unselectable — silently, with the run reporting success. Measured against the
current journal:

- **385 of the 561 entries after position 341 would be stranded.**
- Across the whole journal, **385 entries sit strictly below the running maximum; 0 equal it.**

(The comment at `run-pending-migrations.mjs:113` still says "32 entries … and 6 more equal",
measured when the journal held 672 entries. That figure is stale by an order of magnitude;
it is a script comment, not migration SQL, so it can and should be restated.)

### Is `check:watermark-free` genuinely the only thing holding the door shut? Yes.

- It is the only gate that inspects applier selection logic. Confirmed green: "5 migration
  applier(s) iterate the journal and guard double application; none selects by watermark."
  Self-test: 10 checks, both directions bite.
- **It is in CI**, at `.github/workflows/ci.yml:649-651`, in the `gates` job, on every push
  and pull request, self-test first.
- `check:migration-discipline` cannot substitute for it — it downgrades `journal-order` to a
  NOTE (§2) and so has no bite on this class at all.
- `check:migration-chain` check (c) *would* bite, but it is currently failing for this exact
  pair, so it provides no incremental signal until it is made green.

So the safety of the current arrangement rests on a single CI gate. That is thin but real,
and the gate is well-constructed.

### The correct repair

The repair is to **restamp the two unsealed spliced entries down into the gap below 0619**,
so array order and `when` order agree again. `0619` is sealed and immovable; `0464a` and
`0271a` are not sealed and are the entries that were inserted out of order.

The gap between position 339 (`when 1787895365277`) and position 342 (`when 1787895425277`)
is **60,000 ms** — ample for two entries.

Journal edit, positions 340 and 341, changing only `when`:

```json
{ "idx": 717, "version": "7", "when": 1787895385277, "tag": "0464a_gl_kernel",            "breakpoints": true },
{ "idx": 726, "version": "7", "when": 1787895395277, "tag": "0271a_waitlist_admission",   "breakpoints": true }
```

Then, **on every database where either migration is recorded**, inside one transaction per
database, in the same maintenance window:

```sql
BEGIN;

-- 0464a_gl_kernel
UPDATE drizzle.__drizzle_migrations
   SET created_at = 1787895385277
 WHERE created_at = 1803000010169;

-- 0271a_waitlist_admission
UPDATE drizzle.__drizzle_migrations
   SET created_at = 1787895395277
 WHERE created_at = 1803000010178;

-- Each must report exactly one row. Zero means the migration was never applied here
-- (correct: skip it). More than one means two migrations share a created_at and the
-- restamp is ambiguous — ROLLBACK and resolve by hash instead.
ROLLBACK;  -- promote to COMMIT only after both counts are verified
```

Prefer keying on `hash` where the file hash is known, since `created_at` is not declared
unique. The ledger is `drizzle.__drizzle_migrations (id, hash, created_at)` — the applier
inserts `(hash, when)` at `run-pending-migrations.mjs:86`, and `check:migration-ledger`
reads `(id, created_at)` at line 129 and joins the journal on `created_at`.

Afterwards: re-run `check:migration-ledger` against each database, then
`check:migration-chain` — check (c) should go green **without** adding a baseline line,
which is what the script's CLOSED-set policy demands.

### Why this must not be done now

`0271a_waitlist_admission` is recorded as applied on at least four databases — the
discipline gate annotates it at line 400 with `streamline_crm_merge`, `streamline_crm_e2e`,
`crm_cold_0908` and a scratch. `check:migration-ledger` joins on `created_at`. Restamping
the journal without the matching `UPDATE` on each of those ledgers produces the exact
failure this repository has already realised: an orphan ledger row, plus the migration
lifting above the watermark, so a migration that demonstrably ran is reported pending and
the next `db:migrate` re-applies it.

**The journal edit and the ledger `UPDATE` are one atomic repair that spans machines.** With
no database reachable, only half of it can be performed, so neither half may be. The prior
pass's "document, do not touch" verdict is upheld — for this defect, on this ground.

### The conditions under which the verdict changes

1. **A ledger becomes readable on all four-plus databases.** Then execute the repair above
   in a maintenance window. This is the preferred end state: it removes the regression
   rather than tolerating it.
2. **`check:watermark-free` is removed, weakened, or a sixth applier is added that selects
   by watermark.** Then the regression stops being latent and strands 385 migrations. The
   repair becomes urgent rather than elective.
3. **`0464a` or `0271a` gets sealed** (any `check:migration-immutability:emit --reseal` run
   that sweeps them in). Restamping then becomes a `RENUMBERED` immutability failure and
   option 1 closes. **Reseal before repairing and the repair becomes unavailable** — so if
   the repair is intended, do it before the next reseal.
4. **If none of the above happens**, make `check:migration-chain` green by adding the exact
   pair `"0271a_waitlist_admission -> 0619_chain_creates_what_production_has"` to
   `HISTORICAL_TIMESTAMP_REGRESSIONS`, annotated with where each side is applied, in the
   style of the 16 entries already there. This is a gate-source edit, not a migration edit,
   so BE-60 does not apply. It is the correct disposition **only** if the later entry
   (`0619`) is applied somewhere, which it is — it is sealed.

---

## 5. Migrations 1141 and 1142

Both remain **UNAPPLIED** (neither is sealed; both are above the seal high-water mark, so
`check:migration-immutability` classifies them as normal appends, not back-dated inserts).

### Journal entries — verified

| tag | idx | when | array pos | predecessor `when` |
|---|---|---|---|---|
| `1140_exit_checklist_ownership` | 1028 | 1803000010400 | 900 | — |
| `1141_projects_pm_workspace_optional` | 1029 | 1803000010410 | 901 | 1803000010400 |
| `1142_fix_requisition_headcount_fk_set_null` | 1030 | 1803000010420 | 902 | 1803000010410 |

`idx` unique, `when` unique and strictly increasing, both at the tail of the array. They are
the last two entries in the journal.

### 1141 — forward

`migrations/1141_projects_pm_workspace_optional.sql` is exactly `SET lock_timeout = '5s'`,
a statement breakpoint, and one statement:

```sql
ALTER TABLE "build"."projects" ALTER COLUMN "pm_workspace_id" DROP NOT NULL;
```

**Confirmed: catalog-only, single statement, `lock_timeout` present.** Dropping NOT NULL
takes no table rewrite.

The schema qualification is correct: `projects` was moved into the `build` schema by
`0432_build_schema.sql`, after `0333` installed the NOT NULL against the then-unqualified
table.

**Scope is correct, and this was worth checking.** `0333_pm_workspace_id_not_null.sql` set
NOT NULL on **four** tables — `projects`, `managed_products`, `project_teams`,
`project_workspace_members`. 1141 touches only `projects`. That matches the Drizzle schema
exactly: only `src/db/schema/build/core.ts:46` dropped `.notNull()`;
`managed-products.ts:33`, `teams.ts:20` and `teams.ts:78` all still carry it. 1141 is not
under-scoped.

The column is the second member of composite FK `fk_projects_org_pm_workspace`. Under
MATCH SIMPLE (the default) a NULL in any member leaves the row unchecked, so the FK does not
block the change. Tenancy is unaffected — `org_id` carries its own FK to `organizations`.

### 1141 — rollback

`migrations/rollback/1141_projects_pm_workspace_optional.down.sql` uses the mandated NOT NULL
two-step, **confirmed in the required order**:

1. `ADD CONSTRAINT "chk_projects_pm_workspace_id_not_null" CHECK (...) NOT VALID`
2. `VALIDATE CONSTRAINT`
3. `ALTER COLUMN ... SET NOT NULL`
4. `DROP CONSTRAINT`

`SET NOT NULL` therefore never takes ACCESS EXCLUSIVE for a full scan. The rollback will
fail if any row acquired a NULL while 1141 was live — intended behaviour, not a defect.

### 1142

Forward drops `fk_job_requisitions_headcount_org` and re-adds it as
`FOREIGN KEY ("org_id", "headcount_id") REFERENCES "headcount_requests"("org_id", "id")
ON DELETE SET NULL ("headcount_id") NOT VALID`, then `VALIDATE CONSTRAINT`. `lock_timeout`
present; the `NOT VALID` → `VALIDATE` split is present.

The premise holds: `1128a_requisition_headcount_link.sql` authored the constraint with a
bare `ON DELETE SET NULL` over `(org_id, headcount_id)`. `org_id` is NOT NULL, so a bare
SET NULL would try to null it and the parent delete would abort with `23502`. Naming only
`headcount_id` is the correct repair. The rollback restores the 1128a form and says in its
own header that the restored state is the broken one.

**The column list is still not verifiable statically.** It lives only in
`pg_constraint.confdelsetcols`; Drizzle has no parameter for it
(`src/db/schema/hr/requisitions.ts:37` declares only `.onDelete("set null")`). Reproduced:
`check:set-null-column-lists` exits 2 with "INCONCLUSIVE … 286 constraint(s) are
UNVERIFIED". This is a property of PostgreSQL's catalog, not a gap we could close.

---

## 6. The `23502` deployment hazard — CORRECTED

**The hazard as stated is not reachable.** The claim was: `core.ts:46` declares
`pmWorkspaceId` without `.notNull()` and OpenAPI publishes it nullable, so until 1141 is
applied a write omitting it raises `23502`. Both halves are wrong.

**The request contract is not over-promising.** `openapi.json` publishes
`pmWorkspaceId` on `POST /build`, `POST /agent/v1/projects` and
`POST /build/managed-products` as `{"type":"string"}` with `required: false` — optional.
That has always been correct, because the server supplies a default when the caller omits
it. `createProjectSchema` at `project-core.schemas.ts:89` has declared it `.optional()`
independently of 1141.

**No write path can omit the column.** There are exactly three inserts into `projects`
outside tests — `projects-provision.service.ts:103`, `:206` and
`projects-templates.service.ts:158` — and all three pass `pmWorkspaceId` from a resolver
whose return type is `Promise<string>`:

- `resolveWorkspaceIdForWrite(orgId, requested)` (`pm-workspaces.service.ts:221`) returns
  `resolveDefaultWorkspaceId(orgId)` when the caller omits the field, and otherwise loads
  and validates the requested workspace. It never returns `null` or `undefined`; it returns
  a string or throws.
- `resolveDefaultWorkspaceId` (`:196`) returns `ensureDefaultWorkspace(orgId).pmWorkspaceId`.

So a request that omits `pmWorkspaceId` gets the org's default workspace, not a NULL.
**No `23502` is reachable today.**

**The response contract is already correct for the post-1141 world**, not ahead of it. All
project response schemas publish `anyOf: [string, null]` — `build-core-response.schemas.ts:258`,
`build-project-detail-response.schemas.ts:51`, and every `/build` response in `openapi.json`.
Because the database is still NOT NULL, those fields simply never carry null yet; a nullable
schema accepting a non-null string parses fine. (`build-core-response.schemas.ts:230` is
`z.string()` non-nullable, but that is `workspaceMemberRowSchema` over
`pm_workspace_memberships`, whose column genuinely is NOT NULL. Not a projects hazard.)

### What the real hazard is

**A silent loss of compile-time enforcement.** Removing `.notNull()` from `core.ts:46`
changes Drizzle's `$inferInsert` so `pmWorkspaceId` becomes optional on the insert type.
`pnpm typecheck` is the only gate in this repository that sees a missing required field,
and it will no longer flag a future `insert(projects)` that omits the column. Until 1141 is
applied, such an insert would compile clean and fail at runtime with `23502`. The current
three call sites all supply it, so the window is latent, not live.

**Consequence, stated plainly:** there is no user-visible defect today. The exposure is that
the guard rail came down before the migration that makes the guard rail unnecessary went up.
Applying 1141 closes it permanently, because NULL then becomes legal.

### A second finding: 1141 unblocks the feature but does not deliver it

Commit `24702e40e` is titled "a project can exist without a PM workspace" and correctly
adapts the read paths (`scope-directory.service.ts` guards the workspace lookup and widens
`pmWorkspaceId` to `string | null`). But **no write path can produce a NULL**, because
`resolveWorkspaceIdForWrite` still assigns the default workspace when the caller omits the
field. Delivering the stated feature needs a follow-up: a way for `createProject` to express
"no workspace" — for example widening the resolver to `Promise<string | null>` and having
the DTO distinguish "omitted" from an explicit null. Without that, 1141 changes a constraint
that nothing exercises.

### Deployment ordering

1141 must be applied before any code path is changed to pass `null`. The schema is ahead of
the database; the contract is not.

---

## 7. PostgreSQL floor

**Confirmed: no file in this repository declares a minimum PostgreSQL version.**

- `package.json` `engines` is `{"node":">=22"}` — no database field.
- No `docker-compose.yml`, no `devcontainer.json`/`.devcontainer`, no `.tool-versions`, no IaC.
- No boot-time or gate-time assertion on `current_setting('server_version_num')`. The only
  `server_version_num` references are in `src/scripts/hrms-partition-planner/`, where the
  planner compares the version recorded at plan time against the version at apply time. That
  is a staleness check on a plan, not a floor on the deployment.

PG 15+ holds only in practice:

| Environment | Version | Recorded at |
|---|---|---|
| CI (the only PG service in the repo) | 16 | `.github/workflows/db-gates.yml:77, :409, :490` — `pgvector/pgvector:pg16` |
| Production Aurora, ap-south-1 | 18.4 | `src/db/pool.config.ts:207` (a measurement in a comment) |
| Local scratch / benchmark box | 18.6 | `contracts/benchmark-manifest.json:598` |

### The requirement is already baked into sealed history

`ON DELETE SET NULL (column_list)` is PG15+. Refined count, separating executable DDL from
comments: **96 migration files use the form in executable DDL**; 3 more mention it only
inside a `--` comment.

**Correction to the prior pass:** it named `0265_party_association_columns.sql` as the
earliest use. It is not a use — 0265 mentions the syntax only in a comment explaining why
CASCADE was chosen instead. The earliest **executable** use is
`0578_tenant_fks_public_c.sql`. The earliest sealed executable use is
`0607_vault_access_logs_survive_document_deletion.sql`. Since a sealed migration requires
PG15 to parse, a deployment below PG15 could never have replayed this chain. **1142
introduces no new version requirement.**

### Where the floor should be declared

Three places, cheapest first. All are additive and none touches a migration:

1. **`package.json`** — add a `postgresql` field alongside `engines.node`:
   `"engines": { "node": ">=22", "postgresql": ">=15" }`. Declarative and greppable. Not
   enforced by npm/pnpm, so it is a record, not a gate.
2. **Boot-time assertion** — in `src/db/pool.config.ts`, beside the existing 18.4 note,
   assert `current_setting('server_version_num')::int >= 150000` on first connection and
   refuse to boot below it. This is the one that actually bites, and it fails at deploy time
   rather than at the first `ON DELETE SET NULL` parent delete.
3. **`README.md` prerequisites** — one line: "PostgreSQL 15 or newer (16 in CI, 18.4 in
   production)". Cheapest and it is what a new deployer reads first.

Additionally, `.github/workflows/db-gates.yml` pins `pgvector/pgvector:pg16` in three places.
If a floor is declared at 15, consider a second CI service on `pg15` so the floor is tested
rather than merely asserted; otherwise the declared floor is two majors below anything
exercised.

### Correcting the stale comment in `0265`

`migrations/0265_party_association_columns.sql:44` says `ON DELETE SET NULL (column)`
"needs Postgres 15, which this deployment does not pin". That was true in the Neon era. It is
now contradicted by 96 files, the earliest sealed one being `0607`.

**`0265` is applied and SEALED. Under BE-60 the comment must not be edited in place** — it
would move the `effective` hash and fail `check:migration-immutability`, which exists
precisely because a warm database and a cold build would then disagree.

Correct the record instead, in this order of preference:

1. **This document is the correction.** It names the file, the line, the false claim and the
   evidence. That is the cheapest durable fix and it is already done.
2. **Put the note where the syntax is introduced, not where it is doubted.** Add the floor
   statement to the README prerequisites and to the `pool.config.ts` assertion (§7 above).
   A reader who greps for the PG15 question finds the live answer, not the 0265 aside.
3. **If a superseding migration is ever written near this area**, carry a one-line header
   noting that the 0265 comment is superseded. Do not write a migration solely to correct a
   comment.

Never: `sed` the comment out of `0265`, and never reseal to hide the drift.

---

## 8. Gate results

Every command below was run in this worktree with no `.env` and `DATABASE_URL` unset. All
were confirmed to do no database I/O by reading their imports first:
`check-migration-discipline.mjs`, `check-migration-immutability.mjs`,
`check-migration-rollback.mjs`, `check-drop-column-safety.mjs`,
`check-watermark-free-appliers.mjs` import only `node:fs`, `node:path`, `node:url`,
`node:os`, `node:crypto`. `guard-db-generate.mjs` imports `node:child_process`, but
`--check` calls `runCheck()`, which `process.exit()`s before reaching the `spawnSync`.
`check-set-null-column-lists.ts` imports `postgres` but only constructs a client when
`SET_NULL_GATE_DATABASE_URL` is set (line 274), and it is not.

**Self-tests first in every case**, so no result below is a vacuous pass.

```
pnpm check:migration-discipline:self-test    → 27 passed, 0 failed, SELF-TEST PASSED   exit 0
pnpm check:migration-immutability:self-test  → 13 passed                                exit 0
pnpm check:migration-rollback:self-test      →  9 passed, 0 failed, SELF-TEST PASSED    exit 0
pnpm check:drop-column-safety:self-test      → SELF-TEST PASSED                         exit 0
pnpm check:db-generate-guard:self-test       → 6 checks all true                        exit 0
pnpm check:watermark-free:self-test          → 10 checks, both directions bite          exit 0
pnpm check:set-null-column-lists:self-test   → 14 passed                                exit 0
pnpm check:migration-chain:self-test         → 24 passed, 0 failed                      exit 0
```

```
pnpm check:migration-discipline
  SQL files found: 903
  Baselines: lock_timeout=155 fk-not-valid=44 set-not-null=21 validate-order=2
             do-breakpoint=0 no-journal=0 concurrently=0
  NOTE [journal-order] 0619_chain_creates_what_production_has.sql
    when=1787895425277 is not greater than the preceding entry 0271a_waitlist_admission
    (when=1803000010178)
  check:migration-discipline PASSED — 903 SQL files checked, 0 new violations
exit 0
```

```
pnpm check:migration-immutability
  685 sealed entries against a journal of 903 — 218 newly appended, 400 comment-only edit(s)
  OK — every sealed migration still builds the same database.
exit 0
```

```
pnpm check:migration-rollback
  PASSED — 903 migrations scanned, compliance required for numeric prefix > 839
exit 0

pnpm check:drop-column-safety
  903 migration file(s), 134 dropped column(s), 413 schema file(s)
  OK — no dropped column is still declared in the Drizzle schema
exit 0

pnpm check:db-generate-guard
  903 journal entries, latest snapshot 0464, real drift 438 — db:generate is BLOCKED
exit 0

pnpm check:watermark-free
  OK — 5 migration applier(s) iterate the journal and guard double application;
  none selects by watermark.
exit 0

pnpm typecheck
exit 0   (baseline 0, held)
```

```
pnpm check:set-null-column-lists
  Declared SET NULL foreign keys 606 · requiring a column list 286 · unreachable 0
  Declaration half OK — every declared SET NULL key has at least one nullable member.
  INCONCLUSIVE — the catalog half did not run. 286 constraint(s) are UNVERIFIED.
exit 2
```

### BLOCKED, and the exact external dependency

**`pnpm check:migration-chain` — DELIBERATELY NOT RUN.** The script itself is read-only
(check (f) is a single `SELECT max(created_at) FROM drizzle.__drizzle_migrations`), but
`package.json:309` invokes it as `node --env-file-if-exists=.env src/scripts/verify-migration-chain.mjs`.
In the main checkout `.env` points at **production Aurora**, so running it there opens a live
production connection. This worktree has no `.env`, so the flag would be a no-op here — but
the command is hazardous by construction and was not run on principle.
**What it would report was determined instead by replaying its own `runChecks()` logic
statically: 2 failures, both listed in §2.**
*Dependency to unblock:* remove `--env-file-if-exists=.env` from the script (check (f) reads
`process.env.DATABASE_URL`, which a caller can export deliberately), or run it only where
`.env` is known non-production.

**Applying 1141 and 1142 — BLOCKED.**
*Dependency:* a non-production PostgreSQL 15+ reachable via `DATABASE_URL`. None on this
machine. The existing path is `.github/workflows/db-gates.yml`, whose `bootstrapped` job
builds a `pgvector/pgvector:pg16` service, creates the `streamline_app` role, runs
`db:bootstrap` and replays the chain cold. It triggers on push to `main`, on every pull
request, and nightly at 04:00 UTC.
*Caveat on that path:* its header records that it was measured green at journal head
**672/672**. Head is now **903**. Whether a cold replay still reaches head is unestablished.

**Verifying 1142's `confdelsetcols` actually contains `{headcount_id}` — BLOCKED.**
*Dependency:* `SET_NULL_GATE_DATABASE_URL` against a bootstrapped non-production database,
which `db-gates.yml:155-158` supplies as `postgres://ci:ci@127.0.0.1:5432/ci`. `ci.yml:1136`
runs only the hermetic self-test, by design.

**`pnpm check:composite-fk-set-null` — BLOCKED.** Injects `.env` and opens a live connection
to read `pg_constraint`. Same dependency. Its home is `db-gates.yml:165`.

**Not run, production-touching by name:** `db:migrate`, `db:push`, `db:generate`,
`migration:proof`, `migration:proof:focused`, `check:migration-ledger`, `db:verify-rls`,
`openapi:generate`.

---

## 9. Outstanding, in priority order

1. **Make `check:migration-chain` green.** It is a required CI step failing on `main` for
   the two defects in §3 and §4. This is the only item that is currently breaking a gate.
   Decide between rename (§3) and baseline (§3 fallback) for `1090`; between ledger repair
   (§4) and exact-pair baseline (§4 option 4) for the regression.
2. **Correct the two false premises** in `check-migration-discipline.mjs:332` (§1).
3. **Apply 1141 and 1142** against a non-production PG15+, then verify 1142's
   `confdelsetcols`. BLOCKED on a database.
4. **Declare the PostgreSQL floor** (§7) — README line, `engines.postgresql`, and a
   boot-time `server_version_num` assertion.
5. **Decide whether the `journal-order` downgrade at `check-migration-discipline.mjs:752`
   is intended.** If a `when` regression is worth a baseline list of ~60 entries, it is
   probably worth failing on a *new* one. Today it cannot.
6. **Finish the standalone-project feature** (§6) or revert `core.ts:46` until it is
   finished. 1141 changes a constraint that no write path exercises.
7. **Restate the stale measurement** at `run-pending-migrations.mjs:113` — 385 entries sit
   below the running maximum, not 32.
