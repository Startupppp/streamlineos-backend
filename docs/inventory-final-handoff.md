# InventoryOS — final handoff

**Branch:** `feat/inventory-world-class-implementation` (both repos)
**Written:** 2026-08-29. Re-verify anything dated before you rely on it.

This is the closing record for the InventoryOS programme described in
`inventory.md` and finished against `pending one.md`. It says what is done, what
is reachable, what is only written, and what is blocked — in those terms
deliberately, because the failure this programme kept hitting was the gap between
them.

---

## 1. The one thing to read first

**Committed is not reachable, and this branch proved it three times.**

A unit would be built, typecheck, pass its tests, be committed and ticked — and
nothing would call it. E5's compliance service was the clearest case: it had a
module, the module was registered in `inventory.module.ts`, and
`IndiaComplianceService` had no caller outside its own directory. With the flag
on, nothing happened either way. G3's expiry sweep was the same shape: written,
registered, tested, never triggered. An earlier adversarial review of this module
found nine features in that state.

There is now a gate for it:

```
src/modules/inventory/__tests__/inventory-reachability.spec.ts
```

For every sub-module it requires either an HTTP surface or a caller outside the
module's own directory. Exemptions carry a reason and the test asserts the reason
exists — an exemption with nothing beside it is how a check stops checking.

**Run it before believing any future "done".** It is cheap, and it is the check
that keeps catching us.

The frontend has the equivalent for its own recurring defect:

```
frontend/app/(authenticated)/inventory/inventory-route-states.test.ts
```

which walks all 67 inventory routes and fails when one cannot answer loading,
empty, error or denied. It found 22 gaps on first run.

---

## 2. What "done" means here

Three grades, used precisely below:

| Grade | Meaning |
|---|---|
| **Reachable** | A caller outside the unit's own directory, or an HTTP route. Verified by the reachability spec. |
| **Proven** | Reachable, and exercised against a real database or a real request — not only a mocked unit test. |
| **Written** | The code exists and typechecks. Nothing more is claimed. |

All forty units of `pending one.md` are closed. Grades at close:

- **Proven** — G7 (7/7 on two consecutive independent runs), D2, E3, E4, G5,
  and everything the ~100 seeded e2e assertions walk: the engine, receiving,
  putaway, picking, shipping, returns, recalls, valuation, both optional packs.
- **Reachable** — the rest. Each was verified by finding a caller outside the
  unit's own directory, or an HTTP route, rather than taken from a build report.
  That check moved **four units back to open** during the work, and all four were
  then genuinely closed.
- **Written** — nothing remains in this grade.

Four units were ticked and then un-ticked on this evidence: E5 (a compliance
service nothing called), G3 (a sweep with no trigger), E3 and E4 (rules the
receiving path never invoked). None of them would have been caught by reading
the checklist.

### The reachability check has a sharp edge — read this before using it

"A caller outside the unit's own directory" is the right question for a
*service*. Applied to a **pure planner** — `planCarrierAttempt`,
`planWebhookAttempt`, `planComplianceAttempt`, any `next*DelayMs` — it produces
false positives, because the executor that consumes a planner is normally
co-located with it. Grepping for callers of `planCarrierAttempt` outside
`carrier-adapter.ts` returns nothing, and that code is entirely correct:
`runCarrierCall` sits in the same file, uses the planner and
`CARRIER_CALL_TIMEOUT_MS`, and is called from `carrier-status.service.ts:149`.

**For a planner, both halves must hold:**

1. an executor exists that consumes the plan — walks the schedule, applies the
   timeout — and
2. that executor is invoked from a service on a production path.

E5 failed the first half: `planComplianceAttempt`,
`COMPLIANCE_RETRY_SCHEDULE_MS` and `COMPLIANCE_CALL_TIMEOUT_MS` were exported
and unit-tested, no executor existed, and `register` did
`await adapter.register(request)` once. A portal that refused once was recorded
as final, and `COMPLIANCE_CALL_TIMEOUT_MS` had zero usages anywhere in the
repository, so a provider that never answered left the caller's promise
unsettled — `await` has no deadline of its own. Fixed in `a0fabb43`.

The second half is the more likely future shape: an executor that exists, is
tested, and is called by nobody. A caller-grep on the planner passes it.

Checked on this basis, all four retry families are wired — carrier
(`runCarrierCall` → `carrier-status.service.ts:149`), webhook
(`planWebhookAttempt` → `webhook-delivery.worker.ts:303`, `webhooks.service.ts`),
channel (`withChannelTimeout` + `CHANNEL_CALL_TIMEOUT_MS` →
`channels/lib/channel-snapshot-worker.ts`, in `fetchSnapshot`) and compliance. The seven non-retry
planners each have exactly one production call site: `planRevaluation` →
landed-cost-apply, `planFromQuestion` → inv-copilot, `planReportFromQuestion` →
inv-report-builder, `resolveSampleQuantity` → receipt-inspection,
`resolveTaxSnapshot` → inv-tax-treatment, `resolveDispensingSafety` →
inv-pharmacy, `resolveProposalLines` → po-batch.

**Why the shape is dangerous at all:** extracting a planner is what makes its
behaviour checkable, and it is also what lets the executor never get written.
The green planner spec then reads as proof the behaviour exists. Both failures
found on this branch were that shape.

---

## 3. Migrations

Numbers 0548–0579 belong to this programme.

**A cold build now does real work at `0575`–`0579`, and that is a new failure
surface.** Until them, a fresh database simply never had the platform's
composite tenant foreign keys (risk 4). The four files create 714 constraints and
validate 710 against whatever rows the earlier migrations produced — so if any
seed or backfill in `migrations/` writes a cross-tenant reference that the live
database never contained, the cold build fails there. That is the correct place to fail: the
constraint is right and the data is wrong. But it is a failure that could not
happen before, and it will present as "0575 broke the build" rather than as
"migration N wrote a bad row".

**Editing an already-applied migration orphans its bookkeeping row.**
`scripts/apply-migration-file.mjs` keys on `sha256` of the file contents, so
changing an applied file — *even to fix a comment* — makes it a different
migration as far as `drizzle.__drizzle_migrations` is concerned. Re-applying
inserts the new hash and leaves the old one behind, growing exactly the
unbooked/unmatched drift the reconciler exists to measure. Delete the stale row
explicitly before re-applying, then confirm each hash appears exactly once:

```bash
for f in migrations/0576*.sql; do
  h=$(shasum -a 256 "$f" | cut -d' ' -f1)
  node scripts/db-query.mjs "SELECT count(*) FROM drizzle.__drizzle_migrations WHERE hash='$h'"
done
```

Found while correcting a comment in `0576`/`0577`. It is a general hazard for
anyone touching an applied file, not specific to those two.

**The FKs land after every table exists, so a cold build has a window without
them.** `0575` runs last by necessity — a constraint cannot precede its tables —
which means every earlier migration in a fresh build runs with no composite
tenant FK enforcing anything. Anything in that window relying on one for
integrity gets it only at the end, in bulk, at `VALIDATE` time.

**`drizzle.__drizzle_migrations` is not evidence on this branch.** It was
rewritten mid-session (509 rows down to 380) and several hand-applied rows went
with it, so a migration whose columns are demonstrably live may have no row. Read
the catalog instead.

**The two catalogs agree, so either is safe.** A report circulated during this
work that `information_schema.columns` under-reports on this database. It does
not, and the report has been withdrawn. Checked 2026-08-29: `inv_settings`
returns 32 columns from `information_schema.columns` and 32 from
`pg_attribute`/`pg_class`. The original readings were about ten minutes apart
with three migrations applied in between — drift in time, not a privilege
filter. Recorded because a wrong finding that circulates is worth retracting in
writing.

Applied state below was checked against `pg_class` / `pg_attribute` /
`information_schema`, never against the bookkeeping table.

| Migration | What it adds | Applied |
|---|---|---|
| `0548_inventory_pending_one_permissions` | 4 permission keys + backfill onto the module rungs | ✅ |
| `0549_transit_exit_queue_index` | stranded-transit queue index (R3) | — |
| `0550_recall_evidence` | recall simulation evidence (D4) | — |
| `0552_inventory_valuation_gl_recon_indexes` | valuation + GL recon indexes (D5/D6) | — |
| `0553a_inventory_pack_flags` | four pack flags + one-pack-on CHECK (E1) | ✅ |
| `0561_inventory_hsn_tax_treatment` | HSN + tax treatment (E2) | ✅ |
| `0562_replenishment_proposal_overrides` | labelled proposal overrides (C2) | ✅ |
| `0563_near_expiry_allocation_policy` | near-expiry policy + window (D2) | ✅ |
| `0564_india_compliance_adapters` | adapter flags + `inv_compliance_documents` (E5) | ✅ |
| `0570_channel_snapshot_reconciliation` | channel snapshot recon (E6) | ✅ |
| `0571_inventory_ai_review_and_feedback` | AI review queue + feedback (F3/F6) | ✅ |
| `0572_inventory_landed_cost` | landed-cost vouchers and allocation (G5) | ✅ |
| `0573_shelf_life_allocation_overrides` | per-customer shelf-life floor (D2 extension) | — |
| `0574_inventory_pharmacy_kirana_packs` | pharmacy + kirana pack fields (E3/E4) | not yet |

### The typecheck gate

**One command checks everything, and it was not the one anybody was running:**

```
nice -n 15 node --max-old-space-size=8192 ./node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
```

Three independent gates were each blind to test code, in different ways:

- `tsconfig.build.json` carries `"exclude": ["node_modules", "test", "dist", "evals", "**/*spec.ts"]`. Every typecheck run against it skipped every spec.
- `tsconfig.json`'s `include` was `["src/**/*", "evals/**/*"]` and never mentioned `test/`, so the seeded e2e suite — the highest-value tests in the repo — was typechecked by nothing at all.
- ts-jest runs with `isolatedModules`, which compiles without checking.

So a spec could rot against a signature that moved underneath it and all three
stayed green. `test/**/*` is now in the include, and turning it on cost **zero**
errors in `src` — it has been free the entire time. It immediately surfaced six
real errors in `test/inventory` that nothing could previously see.

**Assert the exit code, never grep for "error".** A tsc that dies on heap
exhaustion prints nothing and greps as zero errors. It needs 8GB.

### Two traps this branch taught

**341 journalled migrations; 243 once had no bookkeeping row.** Their objects
existed; the rows did not. `scripts/apply-migration-file.mjs` applied files
without recording the hash — fixed now, it records on every apply — but
everything applied by hand before that fix was invisibly "pending", including
migrations predating this programme.

`scripts/check-migrations-applied.mjs` reports the list. It compares the sha256
of each journalled `.sql` against `drizzle.__drizzle_migrations` and is the only
tool that can see this state. **It was deleted by an over-broad `git add -A`
during this work and has been restored** — with it gone, nothing could detect
the problem it exists for.

**Reconciled, by verification rather than by bulk insert.**
`scripts/reconcile-migration-bookkeeping.mjs` parses each journalled `.sql` for
the objects it claims to create (`CREATE TABLE/TYPE/INDEX`, `ALTER TABLE … ADD
COLUMN`, comments stripped first) and checks `pg_class` / `pg_attribute` /
`pg_type` / `pg_indexes` before recording anything. Recording blind would have
asserted presence nobody had checked; this asserts only what the catalog
confirms. Result:

| | count |
|---|---|
| recorded (was already, or verified applied then recorded) | 211 |
| genuinely not applied — all payroll/CRM/build, **zero inventory** | 36 |
| claim no checkable object (backfill/grant only) — left alone | 95 |

Five inventory migrations were found genuinely unapplied and were applied:
`0542`, `0547`, `0549`, `0552`, `0574`. **No inventory migration is unapplied.**
The remaining 36 need somebody who owns payroll/CRM to verify object-by-object;
they are listed by `check-migrations-applied.mjs` and are outside this programme.

**`pnpm db:migrate` cannot be used to repair this database.** Drizzle wraps every
pending migration in one transaction, so with 239 reported pending it attempts
the lot and a single failure rolls back everything. It exits `1` with the error
swallowed — the log shows only "already exists" notices. Use
`scripts/apply-migration-file.mjs`, which applies one file as a simple-query
batch and surfaces the real error.

**Half-idempotent migrations fail the whole file on a second run.** `0563` had
`ADD COLUMN IF NOT EXISTS` above a bare `ADD CONSTRAINT`, so re-applying it died
on a constraint that was already correct. Every migration on this branch wants
the `DO $$ … EXCEPTION WHEN duplicate_object THEN NULL; END $$` guard, because
this environment demonstrably re-applies files and has been observed dropping
columns back out.

---

## 4. Permission keys added

All four are in **both** catalogs and backfilled onto `INVENTORY_MODULE_OWNER`
and `INVENTORY_MODULE_ADMIN` by `0548`.

| Key | For |
|---|---|
| `inventory:replenishment:read` | proposals, transfer recommendations, forecast drift |
| `inventory:allocation:override` | taking a lot the allocator would not have, with a reason |
| `inventory:transit:abandon` | clearing stock stranded in transit by a short receipt |
| `inventory:labels:print` | barcode labels, GRN and pick-list PDFs |

Plus `inventory:landed-cost:manage` (G5), and `inventory:audit:read` (D7).

⚠ **A key added to a role template reaches new organisations only.**
`seedSystemRolesForOrg` grants on role *creation*, and `seed-system-roles.spec.ts`
asserts a re-seed must not touch an existing role's grants. Any future key needs
a backfill migration too — `0548` is the worked shape. Target the
`*_MODULE_OWNER` / `*_MODULE_ADMIN` slugs, **not** the `ROLE_TEMPLATES` slugs;
the wrong slug writes zero rows and raises no error.

---

## 5. Events

Every inventory event type must appear in `INVENTORY_WEBHOOK_ROUTES`
(`src/modules/inventory/webhooks/inventory-outbox-consumer.ts`), including the
ones deliberately routed to `null`. An unregistered type is **not** ignored by
the publisher: it is an error, retried, and dead-lettered.

`src/modules/inventory/__tests__/inventory-outbox-coverage.spec.ts` enforces both
directions and earned its keep twice on this branch — once catching three
unrouted notification events, once catching a compliance event whose name was
computed in a ternary and therefore invisible to static analysis. **Name an event
with a literal or a declared `const` map entry, never a conditional.**

Added by this programme: `inventory.lot.expiring`,
`inventory.recall.opened`, `inventory.adjustment.approval_requested`,
`inventory.einvoice.registered`, `inventory.einvoice.cancelled`,
`inventory.ewaybill.generated`.

---

## 6. The database this branch runs against

**Do not trust a green test run as evidence the schema is right.**

At 20:00 on 2026-08-29 the branch's database held 32,245 rows in
`inv_stock_transactions`. At 21:20 the same endpoint returned 749 tables and
**zero rows in every one of them**, with `n_tup_ins = 0` — never inserted into,
so a cold rebuild rather than a delete. Migrations declared in
`src/db/schema/**` were absent from the live catalog, and
`InventorySettingsService.get` selects the full declared column list, so every
settings read 500s and every seeded suite in the repo dies with it.

Consequences for anyone picking this up:

- **Seeded e2e specs are written but mostly unrun.** They need a seeded
  organisation. The golden path (`test/inventory/golden-path.seeded-e2e-spec.ts`)
  is the exception — its first slices are green.
- **Verify schema against `pg_tables` / `information_schema`**, never against the
  drizzle bookkeeping table.
- A repo-wide suite-load failure usually means declared-vs-live column drift, or
  a module registered in `inventory.module.ts` before its file exists.

**The drift was repaired mid-session, by hand.** Sixteen migrations were applied
individually with `scripts/apply-migration-file.mjs` — 0526, 0534–0541, 0543,
0544, 0545, 0550, 0553, 0561, 0562 — covering 32 missing columns across 8 tables
and 8 absent tables. Declared-vs-live is now **zero across 86 inventory tables and
1186 columns**, verified against the catalog on 2026-08-29.

`drizzle.__drizzle_migrations` was rebuilt at least twice during the session and
several hand-applied rows vanished with it. It is not evidence of anything. A
migration whose columns are demonstrably live may have no row, and a row is no
guarantee the columns exist.

---

## 7. Known failures that are not this programme's

Reported rather than hidden, so nobody spends an afternoon on them:

- `frontend lib/rbac/permissions/__tests__/catalog-sync.test.ts` — two ghosts,
  `accounting:attachments:read` and `accounting:attachments:manage`: frontend-only
  keys with no backend catalog entry. Accounting, out of this programme's scope.
- `src/common/cache/cache.service.spec.ts` — pre-existing, untouched by this work.
- ~38 further backend suites outside `inventory/` and `ai/` (access, billing, HR,
  KB, CRM, organization). All pre-existing on this branch.
- **15 typecheck errors outside inventory, newly visible** now that `test/**/*` is
  included: 13 in `test/crm`, 1 in `test/kb`, 1 in `test/helpers`. The worst is
  `test/crm/crm-import-roundtrip.seeded-e2e-spec.ts`, which imports `toCsv` —
  a symbol `crm-export.service` does not export — and calls `.commit()` and
  `.rowsFor()`, neither of which exists. That spec has been referencing a service
  shape that is not there, and no gate was looking. Out of this programme's scope,
  named here so nobody trips over it believing it is new.

### Running the seeded e2e suite

`jest-e2e-seeded.json` sets `testTimeout` to 120000, and that is unreliable for a
multi-step suite when more than one seeded run shares the Neon branch — a slice
that takes 8.7s on a quiet database timed out at 120s while three suites ran at
once, having used 1.5s of CPU in seven minutes of wall clock. It was waiting on
the database, not computing.

**Either run them serially, or give a multi-step suite its own timeout.** The
golden path now sets 300s per slice. A timeout that depends on what else is
running is a flaky test, not a slow one.

### Two product rules worth knowing before writing a fixture

- **A goods receipt refuses the same PO line twice** — "PO line N appears twice on
  this receipt". Two batches against one order line means two deliveries, which is
  also how they arrive.
- **`quality-recalls.service.ts` exports `RecallsService`, not
  `QualityRecallsService`.** Importing the latter resolves to `undefined` and
  reaches `app.get(undefined)`, failing four minutes into a booted app with "Nest
  could not find given element" — precisely the error a typecheck reports in two
  seconds, and precisely what no gate was looking at.

---

## 8. Enabling the optional packs

Everything below is **off by default** and stays off until an organisation asks.

`PATCH /inventory/settings` with `inventory:settings:manage`:

- `packWarehouse` (on by default) · `packKirana` · `packPharmacy` · `packGst`
- At least one pack must stay on — enforced by a service guard *and* the
  `chk_inv_settings_one_pack` CHECK constraint.
- Read the packs from any inventory role via `GET /inventory/settings/packs`;
  the frontend gates pack-owned fields with `<PackGate pack="…">`.

**GST / e-invoicing (E5).** `gstEinvoiceEnabled`, `gstEwaybillEnabled`,
`tallyExportEnabled`, `complianceAdapter`. Separate from `packGst` on purpose:
the pack decides whether HSN fields exist, these decide whether this deployment
talks to an authority.

> ⚠ **No compliance claim is made.** There is no GSP account, no certificate, and
> nothing here has ever contacted a government portal. `stub` is the only adapter;
> it prefixes identifiers `STUB-` so no screenshot or export can pass for a
> filing, and `adapter_is_live` is written at the time so a deployment that later
> configures a real provider cannot retroactively make its rehearsals look like
> filings. Naming an unconfigured provider fails loudly with `NO_CREDENTIALS`
> rather than falling back to the stub.

---

## 9. Leftover risks

Ordered by how often each actually bit during the work, not by severity in the
abstract.

1. **A unit can be committed, ticked, and called by nothing.** This happened
   three times — E5's compliance service, G3's expiry sweep, E3's pharmacy
   receipt rule — and every one was found by a person grepping for a caller
   rather than by a gate. `inventory-reachability.spec.ts` catches the coarse
   version; it judges at directory level, so a service unreachable *from the path
   that claims it* still passes when anything in its own folder uses it. That is
   exactly how E3 hid. **Grep for a caller outside the module before believing a
   tick** — but read *The reachability check has a sharp edge* in §2 first: that
   grep is wrong for a pure planner, whose executor is normally co-located, and
   applying it there flags correct code. A second session ran the sweep on that
   advice and nearly "fixed" a working carrier path.

2. **Two sessions worked this branch concurrently.** Lanes were divided by
   message, but any file touched by both deserves a second look:
   `sidebar-nav-groups-inventory.ts`, `lot-eligibility.ts`, `inventory.module.ts`,
   `migrations/meta/_journal.json`, and — because each had a seam wired by one
   session into code the other owned — `inv-products.module.ts` and
   `so-fulfillment.service.ts`.

3. **A copy of the ATP formula is correct only because of a constraint two
   tables away — and that constraint is not in the schema file.**
   `availableQtySql` gates sellability with a correlated
   `CASE WHEN EXISTS (… is_sellable IS FALSE) THEN 0 ELSE …`. The obvious
   hand-written equivalent — join `inv_locations`, filter `is_sellable IS NOT
   FALSE` — differs on exactly one row: a stock level whose location cannot be
   read. The join **drops** it; the canonical form **keeps** it, matching
   `is_sellable`'s `true` default rather than silently zeroing a warehouse.

   **That row cannot currently exist**, so the two forms are equivalent in
   practice and this is not a live defect. Verified rather than assumed:

   - `inv_stock_levels.location_id` is `NOT NULL`;
   - `fk_inv_stock_levels_location_id_org` is
     `FOREIGN KEY (org_id, location_id) REFERENCES inv_locations(org_id, id)`,
     so the location is same-tenant by construction;
   - `inv_locations_location_id_fk` cascades on delete, so it exists;
   - `inv_locations` has RLS enabled with `USING (org_id = current_org_id())`,
     which is the predicate those FKs already satisfy.

   So a caller who can read the stock level can read its location, and with no
   GUC `current_org_id()` fails closed with `42501` — the query errors rather
   than quietly dropping rows.

   **The catch is where that guarantee lives, and it is worse than "not in the
   schema file".** `fk_inv_stock_levels_location_id_org` is not in
   `src/db/schema/inventory/stock.ts` (which declares only the single-column
   reference) **and is not created by any migration** — see risk 4. It exists on
   the Neon branch and nowhere else. So the argument above is sound *for this
   database*. It **was** false for a database rebuilt from `migrations/` — the
   composite FK existed nowhere else — until `0575` authored it; see risk 4,
   which is now closed. A cold build gets the constraint, so the argument holds
   in both places today. It still cannot be tested: the case cannot be
   constructed on any database that has the FK, which is now all of them.

   That is the sharper argument for A1's single-formula rule than "a copy might
   already be wrong": **a copy's correctness depends on a schema constraint two
   tables away that nobody re-checks when they change it, and here that
   constraint is invisible in the file you would read to check.** Call
   `availableQtySql`; never restate it.

   Deliberately untested: the only way to construct the case is to break the FK
   or forge an RLS state the application cannot produce, and a test asserting
   behaviour in an impossible state would pass forever and tell nobody anything.

4. **CLOSED — every composite tenant foreign key is now authored. Four are
   deliberately left `NOT VALID`.** 635 of the platform's 799 composite
   same-tenant FKs existed only on the Neon branch, created by no migration, so
   a database rebuilt from `migrations/` had nothing stopping a child row
   referencing a parent in another organisation — the constraints
   `backend/CLAUDE.md` §3 requires and says RLS does not replace. Inventory's 79
   were authored in `0575`; the remaining 635 in `0576`–`0579`. Verified: **799
   live, 0 unauthored.**

   The number was got wrong twice on the way, in opposite directions, so the
   query is pinned here — filter on the **definition**, across **all schemas**:

   ```sql
   SELECT n.nspname, c.conname, pg_get_constraintdef(c.oid)
   FROM pg_constraint c
   JOIN pg_class t ON t.oid = c.conrelid
   JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE c.contype = 'f'
     AND pg_get_constraintdef(c.oid) LIKE 'FOREIGN KEY (org_id,%'
   ORDER BY 1, 2;
   ```

   A *name* filter (`conname LIKE 'fk\_%\_org'`) over-counted by 7 in
   inventory; restricting to `nspname = 'public'` under-counted by 132, because
   `build` (129) and `build_events` (3) are real application tables from
   migrations `0431`/`0432`. Distribution: public 667, build 129,
   build_events 3.

   **Two traps worth keeping, because both fail silently.**

   *Schema qualification.* 123 of the 635 live outside `public`. Inventory is
   entirely inside it, so `0575`'s guards are `to_regclass('public.…')`
   throughout, and a generator copied from it skips those 123 without error:
   `to_regclass('public.x')` on a `build` table returns `NULL`, the guard
   concludes the table is absent, and the constraint is never created on a fresh
   build — the guard's own protection inverted. `0576`–`0579` qualify both the
   probe and the `ALTER TABLE`.

   *Definitions that already say `NOT VALID`.* Four constraints are unvalidated
   on this database, and `pg_get_constraintdef` returns the trailing `NOT VALID`
   inside the definition string. A generator that appends its own emits invalid
   SQL. Worse, emitting a `VALIDATE` half for them would succeed on an empty
   database and fail on one carrying the offending data — two environments
   disagreeing about whether a constraint holds, which is the whole defect this
   risk describes. They are therefore added `NOT VALID` with **no** `VALIDATE`,
   reproducing the source state rather than improving on it:

   - `fk_chat_channels_org_creator_membership`
   - `fk_chat_messages_org_sender_membership`
   - `fk_kb_pages_org_created_membership`
   - `fk_kb_pages_org_owner_membership`

   All four reference `organization_members(org_id, id)`. **Why they are
   `NOT VALID` is not established, and this database cannot establish it.** The
   assumption was orphaned membership references. Checked 2026-08-30, all four
   have zero violating rows — but `chat_channels`, `chat_messages` and
   `kb_pages` are **all empty** (0 rows, against 6 `organization_members`), so
   the zero is explained entirely by there being nothing to violate. It is not
   weak evidence that the constraints hold; it is no evidence in either
   direction, and validating them here would succeed for a reason that says
   nothing while the same statement could fail on a populated database.

   That makes "reproduce, don't improve" the right call on firmer ground than
   the reason originally given for it. **Whoever owns chat and KB should
   decide**, counting against data that exists:

   ```sql
   SELECT count(*) FROM kb_pages t
   WHERE t.owner_membership_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM organization_members m
                     WHERE m.org_id = t.org_id AND m.id = t.owner_membership_id);
   ```

   Verification that these files are idempotent used the **name diff**, not a
   count: 635 `ADD CONSTRAINT` against 631 `VALIDATE CONSTRAINT`, the difference
   being exactly those four. A before/after count cannot catch a constraint left
   unvalidated by mistake, because every one already exists and is valid here —
   a fresh build is the only place it would surface, and that is the one place
   nobody runs. Applied twice: 799 live and 4 unvalidated both times.

5. **The seeded suites share one Neon dev branch.** Coverage is not thin: a
   little over 100 seeded e2e assertions currently run green against a real
   database — golden-path 7 (the whole chain), picking-waves 32, pack-fields 19,
   allocation-override 15, landed-cost 13, fefo-expiry 8, order-to-ship 6 —
   across the engine, receiving, picking, shipping, returns, recalls, valuation
   and both optional packs. The problem is contention, not coverage: they cannot
   run concurrently without waiting on each other, and **a CI environment that
   runs them in parallel will see timeouts rather than failures.** Run them
   serially, or give each its own branch.

6. **In-process counters reset on deploy** (G6). They are rates over a window,
   never totals. Anything needing durability is a database query by design.

7. **The route-states `IN_FLIGHT_ELSEWHERE` list is empty today** — verified as
   the literal `new Set<string>([])`, not merely inferred from a passing suite.
   All eight routes parked during concurrent work were fixed. Keep checking it is
   empty before calling the UX sweep complete; a non-empty list is real debt
   wearing a reason.
