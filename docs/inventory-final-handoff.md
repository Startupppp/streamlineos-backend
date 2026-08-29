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

Most of this programme is **Reachable**. The seeded end-to-end suites are
**Written** except where the golden path covers them, because they need a
database with a seeded organisation and this branch's database has been rebuilt
cold more than once (see §6).

---

## 3. Migrations

Numbers 0548–0574 belong to this programme.

**`drizzle.__drizzle_migrations` is not evidence on this branch.** It was
rewritten mid-session (509 rows down to 380) and several hand-applied rows went
with it, so a migration whose columns are demonstrably live may have no row. Read
the catalog instead.

**The two catalogs agree, so either is safe.** One agent reported that
`information_schema.columns` under-reports on this database. That is **not
reproducible**: checked 2026-08-29, `inv_settings` returns 32 columns from
`information_schema.columns` and 32 from `pg_attribute`/`pg_class`. Recorded
because the failure direction would have been safe either way — under-reporting
produces false MISSING, never false OK — but the claim itself does not hold.

Applied state below was checked against `pg_class` / `pg_attribute` /
`information_schema`, never against the bookkeeping table.

| Migration | What it adds | Applied |
|---|---|---|
| `0548_inventory_pending_one_permissions` | 4 permission keys + backfill onto the module rungs | ✅ |
| `0549_transit_exit_queue_index` | stranded-transit queue index (R3) | — |
| `0550_recall_evidence` | recall simulation evidence (D4) | — |
| `0552_inventory_valuation_gl_recon_indexes` | valuation + GL recon indexes (D5/D6) | — |
| `0553_inventory_pack_flags` | four pack flags + one-pack-on CHECK (E1) | ✅ |
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

1. **Seeded e2e coverage is thin against a real database** (§6). The unit and
   guard specs are strong; the end-to-end proof is not, and that is an
   environment problem rather than a code one.
2. **In-process counters reset on deploy** (G6). They are rates over a window,
   never totals. Anything needing durability is a database query by design.
3. **The `IN_FLIGHT_ELSEWHERE` list** in the route-states test names routes whose
   state gaps were real but owned by concurrent work. It is meant to reach zero;
   check it is empty before calling the UX sweep complete.
4. **Two sessions worked this branch concurrently.** Lanes were divided by
   message, but any file touched by both deserves a second look — particularly
   `sidebar-nav-groups-inventory.ts`, `lot-eligibility.ts`,
   `inventory.module.ts` and `migrations/meta/_journal.json`.
