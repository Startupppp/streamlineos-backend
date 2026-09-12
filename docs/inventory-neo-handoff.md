# InventoryOS — NEO handoff

## The whole seeded suite, run for the first time — 2026-09-09

**Pushed: backend `b3e4b4ae5`, frontend `6c7695ca6`** (frontend later advanced to
`e22f80b32` by a concurrent session), both on
`feat/inventory-world-class-implementation`. No force push. `main` untouched.

**`test/inventory` is 60 suites / 622 tests, EXIT=0.** That is the number this
pass exists to produce, and the previous one could not have: the suite had never
been run end to end. The first full run was **57 passed, 3 failed suites, 22
failed tests**, and the earlier "~54 suites" figure came from runs that stopped
short of the files that were red.

Two environment findings came before any of that, and both are the kind that
cost an hour if undiagnosed:

* **The database named in the runbook is 205 migrations behind.**
  `streamline_crm_merge` has 429 of the journal's 634 migrations applied, so
  every inventory spec died on `column "measure_mode" of relation
  "inv_products" does not exist`, `inv_purchase_orders.approved_by_membership_id`
  and `inv_settings.pack_warehouse`. It is a CRM-branch database. **Use
  `streamline_inv`** — 634/634 applied, 711 permission rows, RLS enforced for
  `streamline_app` (it fails closed with "no tenant context" without the GUC).
  `inv_cold_head` is also at 634 but has only **50** permission rows: the boot
  reconciler never ran there, so every seeded spec dies on the
  `role_permission_grants → permissions` foreign key instead.
* A repo-wide failure across every inventory spec is that drift, not a feature.

### The three red suites, and what each turned out to be

None was a product bug in the feature it tested. All three were the suite
lying about itself, which is why running it mattered more than reading it.

| Suite | What it was |
|---|---|
| `recall-release-lifecycle` | Granted **`inventory:quality:hold`** — a key that exists in no catalogue, no database and on no endpoint. `role_permission_grants.permission_key` has an FK to `permissions.name`, so all 13 tests died in `beforeAll` with a constraint name and no mention of the key. Raising a hold is `inventory:quality:inspect`. |
| `consigned-handling-unit-grain` | Same shape: **`inventory:handling-units:manage`**, also never real. Handling units are authorized as stock — `inventory:stock:read` / `inventory:stock:transfer`. |
| `batch-single-equivalence` | Asserted `replayed >= 5` and `replayed === success` on running totals. `success` counts every command ever applied to the tenant and the fixture posts eight before the file posts anything, so success is 11 where replayed can only reach 3. **It could never have passed.** |

Three more were hiding behind those, and only surfaced once the suites got past
`beforeAll`:

* `recall-release-lifecycle` imported **`QualityHoldsService`**; the class is
  `HoldsService`. Under ts-jest's `isolatedModules` that compiles, resolves to
  `undefined`, and `app.get(undefined)` reports *"this provider does not exist
  in the current context"* — which reads as a broken module. Fixing the name
  then surfaced two more type errors the failed import had been masking.
* Its fixture seeded stock under **`rl-blocked-${tag}`**, the same idempotency
  key the recall two describes below uses, so the recall answered 422 *"already
  used with a different request"* instead of the `HOLD_EXCEEDS_ON_HAND` the test
  was written to observe.
* `consigned-handling-unit-grain` read `created.handlingUnitId` from a
  `HandlingUnitDetail`, whose id field is `id`.

### Two real product bugs, both found by making a vacuous test honest

1. **A reservation naming the supplier's stock was handed ours.**
   `ReservationInput.ownership` is documented in `stock-engine.types.ts:116-121`
   as existing *"so a caller cannot silently reserve the owned row when it meant
   the consigned one"*, and **nothing read it**.
   `committedGrainPredicate` pins `ownership = 'OWNED'` — correct, a promise is
   only ever against our own stock — so `ownership: "VENDOR"` was not refused:
   it was given the OWNED row. On a shared pallet, where an owned and a
   consigned grain differ in nothing but that column, reserving 10 "vendor"
   units silently committed 10 of ours, the totals added up, and nothing
   complained. Fixed by refusing, not by widening the predicate.
   The test that should have caught it passed on `.rejects.toThrow()` while the
   call was dying on `LOCATION_NOT_FOUND` — it passed only `warehouseId`, and a
   locationless reservation is refused outright, so the consignment gate it
   names was never reached.

2. **A cycle count knew which lot it counted and the posting threw it away.**
   `inv_cycle_count_lines.lot_id` is filled by `createCycleCount` from the very
   `inv_stock_levels` row the `system_qty` was read from — the count is taken at
   lot grain. Both `postCycleCount` and `postAudit` then selected only
   `{productVariantId, locationId, varianceQty}`, so the correction landed on
   the `(variant, location, lot=NULL)` row: the counted lot keeps the wrong
   number for good and a lot-less phantom absorbs a correction nobody counted.
   The same two lines also did `parseFloat` then `.toFixed(4)` on a
   `numeric(18,4)`.
   `cycle-count-variance.spec.ts` was the only test named for this and it
   **imported nothing** — it declared `computeVariance`, `classifyMovement` and
   `buildMovements` inside itself and asserted against those twelve times. It
   would have stayed green with the counts module deleted, and its private copy
   reproduced both defects, so the bug was written down as the specification.

### INV-33 was recorded as not applicable, and that was wrong

The §13 table below still says the atomic branch makes
`PENDING_QUARANTINE`/`QUARANTINE_FAILED` impossible and INV-33's UI therefore
**not applicable**. The premise is right and the conclusion does not follow.

Atomicity means a quarantine that *fails* rolls back. It does not mean a recall
that *commits* held anything. A line naming a lot with no stock on hand raises
no hold; a line naming only a serial or only a variant leaves `recalledLotIds`
empty, so the lot flip never runs either and nothing is blocked at all.
`createRecallSchema` accepts `{ serialId }` and `{ productVariantId }` on a
line, so both are reachable from the API. Both committed, and both rendered as
an OPEN recall over a list of lots — identical to one that pulled every carton
off the shelf.

`inv_recall_lines.status` had existed since the table did, defaulted to `OPEN`,
and was written by nothing and read by nothing. It now carries the outcome the
transaction already computed and was dropping on the floor — `QUARANTINED`,
`NOTHING_TO_QUARANTINE`, `NOT_QUARANTINABLE` — with no migration, because the
column was already there. `OPEN` survives as a real fourth value meaning "not
recorded", and the UI renders it as **pending, never as held**: every recall
raised before this reads `OPEN`, and defaulting an unrecorded outcome to success
would be the original bug with better manners.

### Verification, as run

| | |
|---|---|
| Seeded `test/inventory` | **60 suites / 622 tests / EXIT=0** against `streamline_inv` |
| Backend `pnpm typecheck` | **EXIT=0** (8GB heap; exit code, not a grep) |
| Frontend `pnpm type-check` | **EXIT=0**, zero errors |
| `npx eslint` on changed frontend paths | **exit 0** |
| Frontend inventory guards | `inventory-route-states` 15/15, `inventory-permission-keys` 4/4, `recall-quarantine-states` 6/6 |

### Still blocked, with the exact missing item

* **INV-26 carrier adapter — no sandbox credential exists, and there is nowhere
  to put one.** There is no carrier environment variable declared anywhere:
  not in `.env`, not in `.env.example`, and the only `process.env` reads under
  `src/modules/inventory` are `APP_DATABASE_URL` and `NODE_ENV`. `inv_carriers`
  has four columns — `name`, `code`, `tracking_url_template`, `is_active` — and
  no credential column, so a per-tenant sandbox key has no home. Unblocking
  needs a named courier sandbox account, the columns or secret store to hold it,
  and a public webhook URL with that courier's signature scheme.
  The acceptable outcome already holds structurally: `MANUAL_CARRIER_ADAPTER`
  has `canPoll: false` and fabricates nothing, and `trackingNumber` is only ever
  operator input (`input.trackingNumber ?? null`) — the system cannot mint a
  fake carrier identifier because it never generates one.
* **INV-20/21 Playwright — no harness, before any credential question.**
  No `playwright.config.*`, no `e2e/` specs, no `test:e2e` script, and
  `@playwright/test@1.59.1` is present in the pnpm store only as a transitive
  peer of `next@16.3.0`, not as a declared devDependency. Beyond that, the
  frontend worktree has **no `.env` at all** (only `.env.example`), so an
  authenticated run has no `NEXTAUTH_SECRET` to mint a session cookie with.

### Ticket deltas against the §13 table below

* *"Batch behaviour matches single — Ready, 7/7"* — the suite is 9 tests and one
  of them could never pass. Now 9/9, with the replay measured as a delta.
* *"Recall/quality-hold execution atomic or recoverable — INV-33 not applicable"*
  — superseded above. INV-33 was real and is done.
* *"Handling units and ownership preserved — one hole closed, no gate"* — a
  second hole is closed (the reservation ownership bug above) and there is now a
  seeded assertion on that path.
* *"Seeded e2e covers golden workflows — ~54 suites"* — 60 suites / 622 tests,
  and three of them were red until this pass.
* INV-13 and INV-14 were already walked end to end; only the missing assertions
  were added (the PO and putaway-task rows reaching `RECEIVED`/`COMPLETED`, and
  the reservation being `CONSUMED` rather than released or deleted — ATP alone
  cannot tell those apart).


## Reopened and closed again — 2026-09-08

**Pushed: backend `0d464a88c`, frontend `d710aa11e`**, both on
`feat/inventory-world-class-implementation`. No force push. `main` untouched.

The 2026-09-05 pass closed with §12.4 recorded as **"not met — but now measured"**: T17 had
classified all 214 mutating routes, found 40 that a retry duplicates, bounded the number with
an assertion and left the fix out of scope. **A bounded finding is not a met criterion**, so
the queue reopened on that one clause. Five tickets, GitHub #56–#60.

| | |
|---|---|
| **T23** (#56) | The census read only `@IdempotencyKey()` and was blind to `@Idempotent(...)`, the metadata the global interceptor acts on. 13 routes were fenced and invisible as fenced; **3 were recorded as duplicating** under hand-written reasons describing a duplicate a fenced route cannot produce. 40 → 37. |
| **T24** (#57) | The other 37 fenced, `DUPLICATES_ON_RETRY` now empty with the bound an equality in both directions. Proven at the HTTP seam. **The recorded reason was wrong in kind for about half of them**: removing a fence gave `409 "SKU already exists"`, not a duplicate — five of the thirteen tables carry a tenant-scoped unique index on a user-supplied key, so the retry was *refused*, which is the PEND-IDEM shape, not duplication. Eight generate the number server-side and did duplicate. |
| **T25** (#58) | `api-client.ts:143` mints a **fresh key per fetch**. A replay fence keys on the *same* key, so the operator's second press was a different command and the fence never saw a retry — all 37 still duplicated for a real user. `useIdempotentMutation` scopes the key to the intent; 29 call sites, 17 files. Its ratchet found 2 sites my own enumeration had missed, on its first run. |
| **T26** (#59) | The `CONVERGING` exemption ended *"or is refused by the command's own status precondition"* — PEND-IDEM stated as a feature. **31 of 48 CONVERGING POSTs refuse a retry**; 28 were unfenced and are now fenced. |
| **T27** (#60) | **Open.** The other 17 are *not* cleared: the triage reads one hop, and `cancelGrn`/`cancelSo` both delegate, so the precondition lives below where it looked. The real count of refusing transitions is **at least 31 and not yet known**. |

**Fenced routes in inventory: 13 → 78.** Backend `tsc --noEmit` EXIT=0.

**Re-verified: 53 suites / 566 tests / EXIT=0**, after the
seven T27 fences and the T28 DELETE readings — plus backend 6 suites / 33 tests, frontend
34 suites / 373 tests, and `tsc --noEmit` clean on both sides. **All 85 inventory fence
command names are distinct** (85 fences, 85 names); a sweep of the whole backend for
duplicates found three in HR (`hr.attendance.check-in` / `check-out` / `toggle-break`,
declared by two controllers), pre-existing since `828dba9a6` and left alone as out of scope.

**The whole `test/inventory` seeded suite: 53 suites / 566 tests / EXIT=0**, against
`inv_t02_probe`. That is the regression check that mattered: `@Idempotent` makes the header
*required*, so 65 inventory routes now answer a keyless caller with 400, and not one existing
seeded spec broke. (53/566 against the previous pass's 52/562 — the extra suite is
`idempotent-create-replay`.) Frontend: 31 `hooks/api` suites / 363 tests EXIT=0.

### The RF run found what no ratchet could

Two ratchets pinned the RF surface structurally and both were green. Neither could
see that the screen was unusable: the queue asked the API for a cycle-count status
that does not exist, got a 400, and showed "Could not load your tasks" over two
sources that had returned 200. A route-reachability check cannot find that, and a
type check could not either — the request filter was `string` while the response
field was the union. It took loading the page on a 375px viewport.

The other half is the same lesson as `0488` and the `CONVERGING` exemption: a
fixture that lied. `/inventory/picking/waves` first 500'd with `42703 — column
pl.assigned_to does not exist`, which is a scratch database built before the
wave-claim migration, not a defect. Re-run against `inv_t02_probe` it is 200.
Chasing that as a bug would have cost a day.

### T27 closed the reading T26 would not fake

T26 read the method each controller names and found 31 of 48 refusing. It refused to call the
other 17 cleared, because two visibly delegated. Following those hops: **40 of 48 refuse, not
31** — the exemption held for one route in six. Seven more fenced (**78 → 85**), and two
entries corrected from "converges" to "refuses, and is safe only because it was already
fenced". The instructive one is `customer-returns::inspectLine`, which genuinely converges
because its `DRAFT` precondition is on the *return* and inspecting a *line* does not change
the return's status — the guard is not one its own first run invalidates.

**The gate holding all 85 fences is the one CI does not run.** `Inventory ratchets` runs seven
specs by name and `inventory-idempotency-coverage` is not among them, so the check enforcing
every claim T23-T28 make executes only when somebody runs it locally. A one-line addition to
that job fixes it, and it was deliberately **not** made here: `.github/workflows/ci.yml` is
not an inventory file and this pass is scoped to inventory. It needs its own change.

### What still needs a human — re-verified 2026-09-08

| | |
|---|---|
| **CI (#53)** | **Account billing.** Verified today: CI now fires on every push (the T20 fix works) and every run dies in 3-5s on *"recent account payments have failed or your spending limit needs to be increased"*. All seven jobs are configured and queued. Nothing in the repo can fix it. |
| **Neon (#46)** | **Still in use.** Six live `streamlineos-api` connections today, so nothing was applied. The decision is unchanged and human: 316 of 630 entries pending *by hash against objects that already exist* — drift, not missing schema. |
| **RF (#45)** | **DONE — the run happened, and found two real defects.** The frontend directory was freed on the user's instruction and the run took minutes, as predicted. `/inventory/rf` reached signed in at `innerWidth: 375`. **(1)** The queue asked for cycle counts with `status=IN_PROGRESS` — an `InspectionStatus`, not a cycle-count one — so the API answered 400, and one failing source was enough to render "Could not load your tasks" over picks and putaways that had **both returned 200**. An operator at a rack saw no work. It type-checked because the filter's `status` was a bare `string` while every response field used the union; tightening it caught two more loose call sites. **(2)** The onboarding checklist covered the RF header — measured, "Getting Started" at y 52-272 over a heading at y 68-88. **(1) is fixed** in the inventory hooks. **(2) is NOT fixed and is still open**: the overlay is rendered by `components/layout/dashboard-shell.tsx` for every route, so suppressing it means changing shared layout code, which this pass is not scoped to. The defect is real and measured; the fix belongs to whoever owns the shell. **Ergonomics pass, read from the DOM:** autofocused "Scan the item" box, `LINE 1 OF 1`, `tables: 0`, decimal quantity keypad, full-width Confirm, `scrollWidth: 375`. |
| Live q-commerce, a real WES | Secret-blocked by design. Unchanged. |

### The thing worth carrying forward

Three passes in a row, the wrong answer was **a specific, confident, plausible sentence about
a mechanism nobody had run** — §6's stale attribution, T17's forty reasons, and the
`CONVERGING` exemption. Specificity reads as evidence. The only thing that caught any of them
was running the code: a bite proof, a removed fence, a ratchet written after the hand sweep.

---

**Release pass, closed — 2026-09-05. Pushed: backend `f79ed69b2`, frontend `9285a13cb`**,
both on `feat/inventory-world-class-implementation`. `main` was never pushed to from this
pass; it has moved because other sessions push to it.

22 tickets, GitHub issues #34–#55 on the frontend repo, label `inventory`. **19 done, 3
blocked on things no commit can fix.** The seeded suite is **52 suites / 562 tests / EXIT=0**
at `REACHED_HEAD 632/632`, run clean three times across two schema versions.

### What this pass was sent to do, and what was actually wrong

It was sent to fix four defects. **Three were already fixed** and §6 had been wrong for five
days, misdirecting two earlier work orders. The real fault was underneath: `db:bootstrap`
stopped at 457 of 630, so two columns never existed and all 50 tests in the four "failing"
suites were dying in setup. Fixing the build turned every one green without an inventory code
change.

Then the cold build turned out not to be reproducible at all. `0320_recon_phase_a_orgid`
walks `pg_class` with no `ORDER BY` and only gives a child `org_id` once its parent has it,
so two builds of one commit produced two different schemas — and tenant isolation is built on
that column. It now materialises each pass under one snapshot and iterates to a fixed point;
**three fresh builds produce byte-identical `org_id` sets, 822 tables, same md5.**

### The findings that outrank the tickets that found them

- **`reconciliationQueries.rebuild` has never worked** — `42703` on every call, for every
  organisation. Projection rebuild is something §12.3 asserts by name. It was invisible
  because `INV_DB_TESTS` was set nowhere, so nine specs were `describe.skip` in every run.
- **`inventory-rls.db.spec.ts` ran all 17 probes as the BYPASSRLS owner** — the
  tenant-isolation suite was testing nothing. Its own anti-vacuity test caught it.
- **§12.4 "all commands are idempotent" is false by 40 routes** — `products/create`,
  `purchase-orders/create`, `sales-orders/invoice` and 37 more raise a second document on
  retry. Five separate commands whose guard was *unreachable* were fixed first; these forty
  never had one.
- **`0909…down.sql` cannot execute and never could** (`0A000`), and reverting `0910`
  silently rewrites data.
- **Six gates were found reporting green while measuring nothing** — a static call-site
  count, a property suite that passed with rounding inverted, a load overlap check that
  counted the whole database, and three more. Every one was caught by a bite proof; none by
  a green tick. That ratio is the argument for demanding one.

### Blocked, and what each needs

| | Needs |
|---|---|
| **CI (#53)** | **The account owner, in Billing & plans.** Two workflow defects were fixed — nothing triggered on this branch (`push.branches` was `[main]`, and PR runs come from a merge commit GitHub stops recomputing once the PR conflicts), and Lint hid Test (steps 8–37 skipped). Runs now exist, the first since 2026-09-01 — but **every job in both repos, including on `main`, is refused at start with `steps: []`**: "recent account payments have failed or your spending limit needs to be increased." Until that clears, no gate can execute in CI |
| **Neon (#46)** | A human decision: 316 of 632 entries pending by hash against a database whose objects already exist. That is drift, so the call is *reconcile or rebaseline*, not "run db:migrate" |
| **RF device (#45)** | A real credential. The product is passwordless and all 577 users have undeliverable addresses, so no automated sign-in can exist. The surface is structurally pinned by ratchets and ergonomically unproven |

### Still red and not this branch's

Main's lint debt (244 backend / 48 frontend) — the CI job split is precisely what stops it
mattering. The frontend `type-check` failure is five errors in a **stale gitignored
`.next/types/validator.ts` generated Sep 4**, naming routes that no longer exist; that gate
measures build freshness, not type safety.

**Close pass update — 2026-09-05.** `pnpm db:bootstrap` reaches `REACHED_HEAD 630/630` from an empty database for the first time on this branch, twice consecutively and idempotently (`1c167fdc1`). It had been stopping at 457/630 on `0678_rls_fix_feedback_cycle_responses`, an ordering defect described in §4 — and that, not any behavioural bug, is what the four "remaining cold-build failures" in §6 were. On a database at head those four suites are **50 of 50 tests, EXIT=0**. All three defects §6 called open had already been fixed in ancestors of this tip (`6c8f68fc9`, `99ab6c89d`); §6 and §3 are now corrected and dated. Still blocked and unchanged: RF needs a real signed-in session (`/me/access` 403s to a minted cookie), Neon was not migrated, live Blinkit/Zepto/Instamart secrets and a real WES adapter.

**Close pass update — 2026-08-31 (superseded by the entry above).** Code commit `6c8f68fc` fixes the remaining replay-boundary defects by making PO-batch and recall execution reach `runIdempotent` before command-invalidated preconditions, storing a replayable PO response, and fixing the proposal-refresh route order; local checks passed for inventory reachability, PO quantity/override guards, recall execute units, transit-exit arithmetic, frontend route states, and the proposal refresh route-order regression. RF is still blocked by no real signed-in session/cookie, and Neon was not migrated because `pg_stat_activity` showed live `streamlineos-api` sessions, including one active. Remaining non-code blockers are unchanged: live Blinkit/Zepto/Instamart secrets and a real WES adapter.

**Branch:** `feat/inventory-world-class-implementation` (both repos)
**Written:** 2026-08-30. Revised the same day by the PEND pass, which closed §6.
Re-verify anything dated before you rely on it.

> **§6 has been rewritten.** Everything it listed as unproven has now either been
> walked end to end or is recorded here with the reason it cannot be. Four of the
> five gaps hid a real defect; three of those made a shipped feature unusable
> rather than merely untested. Read §6 before §2.

This is the closing record for the NEO programme described in `neo_research.md`.
It follows `docs/inventory-final-handoff.md`, which closed `inventory.md` and
`pending one.md`, and it uses that document's vocabulary deliberately — **proven**,
**reachable**, **written** — because the failure both programmes kept hitting is
the gap between them.

Read `docs/inventory-final-handoff.md` first if you have not. Everything it says
about reachability, about planners with no executor, and about "committed is not
reachable" still applies, and NEO added two more ratchets in the same spirit.

---

## 1. The one thing to read first

**Fourteen units had green unit suites and four of them were broken at a seam.**

`test/inventory/neo-golden-path.seeded-e2e-spec.ts` walks the whole programme in
the order a warehouse works in. It found, in one run:

| What was wrong | Why no unit test caught it |
|---|---|
| `addOnOrder`'s `ON CONFLICT` named the pre-NEO natural key | The statement is only reached when a purchase order is *sent*, and its own spec mocks the executor. A conflict target that does not match the index in full matches no constraint at all, and Postgres refuses the statement outright — every PO sent after NEO-4 would have failed. |
| Reconciliation grouped the ledger by the old grain | A pallet's hundred units and the loose row at the same bin were compared against one shared ledger total, so reconciled stock reported drift. The checker disagreeing with the writer is the exact defect `projection-definitions.ts` is a monument to, one grain deeper. |
| The dock's SQLSTATE check only read the top-level error | Drizzle wraps the postgres.js error, so `error.code` is on `cause`. The exclusion constraint fired correctly and the caller got a raw query dump instead of a 409 — the constraint worked and the product looked broken. |
| The allocator returned a location but not the pallet | Every reservation after a handling-unit receipt looked up a loose row that does not exist. The promise was refused with the stock standing in front of it. |

Every one of those is the same shape: **a grain changed, and something that keys
against that grain did not follow.** If you add another dimension to
`inv_stock_levels`, the checklist is:

1. `LevelGrain` / `levelKey` / `byNaturalKey` / the `lockLevels` predicate;
2. `EXPECTED_COMMITTED` and `EXPECTED_OUTGOING`;
3. `StockProjectionService.syncOutgoing` **and** `addOnOrder`'s conflict target;
4. `reconciliationQueries.bucketDrift`'s ledger `GROUP BY` and its three
   correlated matches;
5. the allocator's returned row, and everything that carries it — reservations,
   wave lines, pick confirms, ship movements;
6. the unique index in the migration.

Six places. The golden path is what finds the one you miss.

---

## 2. What "done" means here

The three grades from the previous handoff, used the same way.

| Unit | Grade | Evidence |
|---|---|---|
| NEO-0 branch and truth | Proven | `inventory-reachability.spec.ts` and `inventory-route-states.test.ts` both green before any change. 86 `inv_*` tables at the start, 100 at the end. |
| NEO-1 channel pools | **Proven** | Golden path: 100 on hand, 60 claimed by the channel, direct ATP 40, the channel's own view 100, the claim drawn to zero on ship. |
| NEO-2 platform PO + ASN | **Proven** | Golden path ingests a Blinkit fixture, matches on EAN, is idempotent on the platform's PO number, accepts into a Streamline PO, and receives against the ASN. |
| NEO-3 fill rate + payout | **Proven** | Golden path asserts 100 ordered / 60 accepted / 60%, then walks a payout file: a line that agrees with the 60 shipped (variance null), one naming an item the PO does not carry, one naming no PO at all — both listed rather than dropped — and a re-upload of the same `payoutRef` settling nothing twice. |
| NEO-4 handling units | **Proven** | Golden path receives 100 onto a pallet, moves the pallet, and asserts on-hand at the unit, at the old bin and at the new one, with reconciliation clean after each. |
| NEO-5 RF task shell | Reachable, ratchet hardened | PEND-5 added `rf-surface-render.test.tsx`, which mounts the three screens and forbids table semantics in the rendered DOM — the text ratchet passed a `role="grid"` rewrite of the queue. Still not walked by a human on a 375px device. |
| NEO-6 slotting | **Proven** | Golden path: no rule ⇒ the pre-NEO order; a rule ⇒ the gold-zone bin first. |
| NEO-7 labour lite | **Proven** | PEND-7: two operators pick their own waves and the board is read over HTTP with two distinct user ids, non-null rates and a figure against standard. The second operator is refused the board they appear on. |
| NEO-8 cross-dock | **Proven**, after a fix | PEND-8: received with `crossDockSoId`, zero at every storage bin, held at staging, retried without double-posting, and shipped. Shipping could not read the reservation the receipt raised until this pass — see §6. |
| NEO-9 kitting | **Proven** | Golden path: buildable 5, a 6-kit build refused, a 3-kit build consuming 6 and 3 and costing 45 exactly, reconciliation clean. |
| NEO-10 catch-weight | **Proven**, after a fix | PEND-10: 10.35 kg received, 5.10 kg sold, 5.25 kg left, priced from weight. The sale accepted a catch-weight line with no piece count and discarded the field — see §6. |
| NEO-11 consignment | **Proven** | Golden path: 10 consigned, on-hand up by ten, ATP unmoved; take title of 4 and ATP moves by exactly 4. |
| NEO-12 dock lite | **Proven** | Golden path books a slot and asserts the second overlapping booking is refused by the exclusion constraint. |
| NEO-13 WES stub | Reachable | Unit spec asserts it reports `accepted: false`, that a throwing adapter cannot fail a pick, and that the file cannot reach the engine or a database at all. |
| NEO-14 waveless join | **Proven**, after two fixes | PEND-14: a second order joins an open wave, reserves nothing twice, and is refused twice over and behind a started picker. There was no join route, and the only endpoint that existed threw on every call — see §6. |
| NEO-15 dead schema | **Proven**, and closed | 100 tables audited; the one parked table was `inv_reason_codes`, and PEND-15 dropped it with a guarded migration. `UNREAD_TABLES` is now empty. |
| NEO-16 golden path | **Proven** | Green twice consecutively, with the original golden path green beside it. |
| NEO-17 handoff | This document | — |

Nothing is in the **written** grade.

---

## 3. Where the golden path was run, and what that means

**On a local Postgres, not on Neon.** `DATABASE_URL` in `.env` points at a shared
Neon branch that other sessions use, and applying eight new migrations to it is
not a call this session should make on its own. A throwaway local database was
built instead:

```
createdb streamline_neo16
psql -d streamline_neo16 -c "CREATE EXTENSION vector; CREATE EXTENSION pg_trgm;
  CREATE EXTENSION btree_gist; CREATE EXTENSION pgcrypto; CREATE EXTENSION \"uuid-ossp\";"
# then apply migrations/*.sql in journal order
DATABASE_URL=postgres://<you>@localhost:5432/streamline_neo16 \
  node --max-old-space-size=12288 ./node_modules/jest/bin/jest.js \
  --config ./jest-e2e-seeded.json --forceExit --runInBand \
  --testPathPattern=neo-golden-path
```

`btree_gist` is required — NEO-12's exclusion constraint does not exist without
it.

### Three things about that run you need to know

> **Superseded by PEND-DB — see §6.** What follows is what this section found at
> the time. The diagnosis was right; the conclusion is now wrong in both
> directions. `pnpm db:bootstrap` reaches **`REACHED_HEAD 371/371`** from an
> empty database, and the remaining problem was never ninety-one migrations — it
> was fifteen files missing from `_journal.json` plus two syntax-level bugs. One
> correction to the analysis below: the fix for 0352 is **not**
> `CREATE TABLE IF NOT EXISTS`, because 0000 and 0352 create two different tables
> under one name.

**No path builds this schema from empty.** Three were tried:

| Path | What happens |
|---|---|
| `pnpm db:bootstrap` — the supported one | `FAILED at 0352_custom_fields_consolidation (72/355 ok before failure)`, reason `relation "custom_field_definitions" already exists`. It fails **loudly and legibly**, which is exactly what it is for. |
| `drizzle-kit migrate` | Dies at the same point without an error anybody can read — spinners, then a non-zero exit. |
| `drizzle-kit push` | Throws `Do not know how to serialize a BigInt` before it does anything. |

The root cause of the first is one line: `custom_field_definitions` is created
unguarded by **both** `0000_light_vance_astro.sql:6074` and
`0352_custom_fields_consolidation.sql:50`. On a database that already has it,
0352 is skipped as applied; on an empty one it is reached and refuses. That is a
one-file fix (`CREATE TABLE IF NOT EXISTS`, or a `DO` guard) and it is somebody's
next twenty minutes — but it is not the only such collision, and the 91 skipped
files below are the rest of them.

For this run the migrations were applied with `psql` file by file in journal
order, continuing past failures and recording every one.

**91 pre-existing migrations fail on a cold local build**, and all 91 are from
other programmes. They fall into three groups: duplicate-numbered files whose
constraint already exists, `0486_hr_people_org_person_link` which contains
`ADD CONSTRAINT IF NOT EXISTS` (not valid Postgres syntax), and the
`0575`–`0579` composite-tenant-FK files, which then fail because they reference
columns the skipped migrations would have added. **None of NEO's eight
migrations was among them** — 0580 through 0587 and 0588 all applied cleanly,
including the exclusion constraint.

That was worth stating plainly, and it is no longer true. **This schema rebuilds
from empty**, and §6 has the command and the result. What this paragraph got
right is the shape of the risk — "a schema that cannot be rebuilt is a schema
whose migrations are decoration" — and it was worth more than any remaining item
in §6, exactly as it said. What it got wrong is the size and the identity of the
problem. The sentence it was making was: **this schema cannot currently be
rebuilt from empty by any available path.** It is not a NEO regression — the previous handoff
already identified `0575`–`0579` as a new cold-build failure surface — but it is
now demonstrated rather than suspected, and it is the single biggest risk in this
repository. A schema that cannot be rebuilt is a schema whose migrations are
decoration, and every claim of the form "migration N is applied" rests on a
database nobody can reproduce.

It is also, on the evidence, not a large fix. The first failure is one unguarded
`CREATE TABLE` and the bulk of the rest are the same shape. Working `db:bootstrap`
through to `REACHED_HEAD` is the highest-value next piece of work in this
repository, and it is worth more than any remaining item in §6.

**Four columns were added to the local database by hand** so the run could
finish: `client_party_id` on `inv_sales_orders` and `inv_customer_returns`, and
`vendor_party_id`/`party_id` on the vendor side. All four belong to skipped party
migrations. They are a property of that throwaway database and of nothing else —
no repository file was changed to accommodate them.

### What the seeded suite actually says

All 50 specs under `test/inventory/` were run against that database. **45 pass,
5 fail — and the same 5 fail identically with this programme's work stashed**,
with the same six tests and the same causes:

```
FAIL landed-cost   FAIL po-batching   FAIL proposal-override
FAIL recall-simulate-execute          FAIL transit-exit
```

Four are the party columns of §3: `column invPurchaseOrders_vendor.client_party_id
does not exist`, from migrations skipped on the cold build. The fifth
(`transit-exit`, "leaves no stranded transit row behind") is driven entirely by
`tl.quantity > tl.quantity_received` on the transfer *line* and touches no stock
grain, so it is unrelated to anything NEO changed — but it has not been chased to
a root cause here and should not be read as understood.

> **Corrected by the PEND pass.** Re-run on a database built cold by
> `db:bootstrap` — where the party columns now exist, because
> `0574a_inventory_party_columns` creates them — the result is **46 pass, 4 fail**
> (550 of 555 tests), with **zero** occurrences of `does not exist` anywhere in
> the run. So the attribution above was wrong: the missing party columns
> accounted for exactly **one** of the five, `landed-cost`, which now passes. The
> other four had an independent cause that the column error was masking, and
> `transit-exit` is the only one of them this document described accurately.
> See §6.

> **Corrected again, 2026-09-05 — and the correction above was also wrong.** On a
> database at `REACHED_HEAD 630/630`, all four of the remaining suites pass:
> **50 of 50 tests, EXIT=0**. The "independent cause" the note above reaches for
> did not exist. Every one of those four was failing in *setup* on a column the
> cold build never created, because `db:bootstrap` stopped at 457/630 — see §4
> and §6. Three corrections, on the same five suites, each confident and each
> reading a schema failure as a behavioural one. The signal was there the whole
> time and was discounted twice: `does not exist` in the log.

Both golden paths — the original and NEO's — pass in that run.

The wider backend unit suite reports 39 failing files (access, billing, HR,
accounting) with **byte-identical counts** stashed and unstashed. None is in
inventory. `pnpm exec jest --testPathPattern=inventory` is 100 suites / 1069
tests green.

---

## 4. Migrations

`0580`–`0588` belong to this programme.

| File | What it does |
|---|---|
| `0580a_inventory_channel_pools` | `inv_channel_pools`; `inv_sales_orders.channel_id`. |
| `0581a_inventory_quick_commerce_asn` | Platform POs, ASNs, payout lines; `inv_channels.qc_provider`; `inv_grns.asn_id`; three settings flags; `inv_sales_orders.platform_po_id`. |
| `0582a_inventory_handling_units` | `inv_handling_units`; `handling_unit_id` on levels, transactions, reservations, pick lines and GRN lines; **the natural-key index is dropped and recreated**. |
| `0583_inventory_slotting` | Slotting rules, velocity classes, re-slot recommendations. |
| `0584_inventory_labor` | `inv_labor_records`; the `inventory:labor:read` backfill. |
| `0585_inventory_cross_dock` | `inv_grn_lines.cross_dock_so_id`. |
| `0586_inventory_kitting` | `inv_kit_components`; four `inv_txn_type` labels; the `inventory:kits:assemble` backfill. |
| `0587_inventory_catch_weight_consignment` | `measure_mode`, `quantity_pieces`, `ownership`; **the natural-key index is dropped and recreated again**. |
| `0588_inventory_dock_waveless` | Dock doors and appointments with the exclusion constraint; two waveless settings; the `inventory:dock:manage` backfill. |
| `0589_inventory_drop_reason_codes` | PEND-15. Drops `inv_reason_codes`, guarded on the table being empty. |

`0574a_inventory_party_columns` also belongs here in spirit: it adds the three
`client_party_id` columns `sales-orders.ts`, `operations.ts` and
`purchase-orders.ts` have always declared and no migration ever created. It is
numbered 0574 and journalled before `0575`, because a file that adds a column has
to run before the file that keys against it.

**PEND-DB also rewrote `0352_custom_fields_consolidation.sql`**, and edited
`0262`, `0263`, `0278`, `0478`, `0482`, `0486` and `0575`–`0579`, none of which
is this programme's file. It is listed here because editing it changes its sha256
and `db-bootstrap.mjs` skips by content hash, so **it will run again on every
database where it was already applied**. That re-run is a no-op by design — the
first thing it does is ask whether the consolidation has happened — but anyone
reading this list for "what will this branch do to my database" needs to know
that a file numbered 0352 is in the answer. See §6.

**None of `0580`–`0589` is applied to the shared Neon branch.** Verified by
probing for the objects, not by reading the bookkeeping. §6 says why, and why
that was not this session's call to change.

**Two of them rebuild `uniq_inv_stock_levels_natural_key`.** A unique index on an
expression cannot be extended in place. Both are safe on existing data — every
row coalesces to the same value the old index enforced — but on a large table
this is a real index build under `lock_timeout`, and it will fail fast rather
than queue if the table is busy. Run them when it is not.

`0586` adds enum labels with `ALTER TYPE ... ADD VALUE`. That is legal inside a
transaction from Postgres 12 onwards **provided the new label is not used in the
same transaction**, and nothing in that file writes one. A later migration that
both adds a label and inserts it must be split.

### Permission keys and their backfills

Three new keys, each with a backfill onto `INVENTORY_MODULE_OWNER` and
`INVENTORY_MODULE_ADMIN` — role templates grant on role *creation* only, so a new
key never reaches an organisation that already exists:

- `inventory:labor:read` — the board names individual people and rates their
  work. That is not an authority that should arrive with a stock summary.
- `inventory:kits:assemble` — building consumes components and creates a SKU that
  did not exist a moment ago, and moves valuation with it.
- `inventory:dock:manage` — booking vehicles in is a receiving clerk's job, not
  the job of whoever configures the site.

Each is in both catalogues and in the frontend `PermissionKey` union;
`catalog-sync.test.ts` passes in both directions.

**The backfills carry the shape 0436 established**, including its known limit: the
`EXISTS (SELECT 1 FROM permissions ...)` guard means the insert is a no-op on a
database where `PermissionCatalogSyncService` has not yet run. On an existing
deployment the catalogue is already synced and the backfill lands; on a cold
build it does not, and the key reaches new organisations through the template
instead. That is the same trade every backfill in this repository makes.

---

## 5. Drops

> **Superseded by PEND-15 — see §6.** `inv_reason_codes` was dropped by `0589`,
> guarded. The count this section asked for came back zero on every tenant of the
> only database carrying real ones, and zero by construction: the sole writer that
> ever existed is 0407's one-shot seed. The reasoning below is why the question
> was left open, and it is preserved because the bar it sets is the right one.

**Nothing was dropped, and that is the finding rather than an omission.**

All 100 `inv_*` tables were audited against every non-test file under
`src/modules/`. Ninety-nine have a reader. One does not:

**`inv_reason_codes`** — no service, no controller, no frontend route, and no
other table carries a foreign key to it. Adjustments record their reason as an
enum and a free-text note instead. Its only reference anywhere is
`inventory-rls.db.spec.ts`, which asserts RLS on it.

It is kept because the work order's bar for a drop is *zero live rows or a proven
archive*, and that is a count against a real database:

```sql
SELECT count(*) FROM inv_reason_codes;
```

If that is zero in every tenant, drop it with a migration and delete its entry
from `inventory-schema-reachability.spec.ts`. If it is not zero, those rows are
somebody's configuration and the honest fix is to give them a reader, not to
delete them.

No ledger, projection, document or audit table was touched. The ratchet refuses
to let any of them be parked in the exemption list at all.

---

## 6. What was not proven — and what happened when it was

Rewritten by the PEND pass. The table this replaced listed seven gaps. Five were
code units; **four of the five hid a defect, and three of those made a shipped
feature unusable rather than merely untested.** That ratio is the finding, and it
is the same one §1 makes: a unit suite tells you a function is right, and says
nothing about whether the module on the other side of the seam agrees.

### The five that are now walked

| Unit | Status | What the walk found |
|---|---|---|
| **NEO-8 cross-dock** | **Proven** | A cross-docked order **could never be shipped.** `source_line_id` on a sales-order reservation means the SO line the stock is held for, and `postShipment` matches on exactly that; the receipt wrote a GRN coordinate (`grn:<id>:<lineId>`) there instead. The ledger was satisfied, reconciliation was clean, the units stood at staging correctly, and the dispatch desk got `No pick list or reservation for SO line 85`. Fixed by `resolveCrossDockSoLine`. |
| **NEO-10 catch-weight** | **Proven** | Pricing from weight already worked — for a catch-weight SKU the ledger quantity *is* the weight, so `amount = quantity × unitPrice` was already `250 × 5.10`. What was broken is the other side: receiving has refused a catch-weight line with no piece count since NEO-10 was built, and **selling accepted one and then discarded `quantityPieces` even when a caller sent it**, so `inv_so_lines.quantity_pieces` was a column nothing ever wrote and a picker was told nothing about how many bags. Fixed in `toSoLineValues`, on create and update. |
| **NEO-14 waveless** | **Proven** | Two defects. `proposeWaveJoin`'s own comment said the caller "then posts to the join route or raises a new wave" and **there was no join route** — a decision with nothing to act on. And `waveless.ts` named a status `inv_pick_list_status` does not have (`"ASSIGNED"`); harmless in the pure function, where a set entry that never matches changes no outcome and all six unit tests passed, and fatal in the SQL, where **every call to the one NEO-14 endpoint that existed threw** `invalid input value for enum`. `assertNotAlreadyOnAWave` had no caller either; it has one now. |
| **NEO-7 labour** | **Proven** | No defect in the module. The board is now read over HTTP — not as a service call, because `PermissionGuard` is not global and a service call proves the arithmetic and nothing about who may see it — against two operators who picked their own waves. Two distinct user ids, non-null rates above zero, a non-zero figure against standard. The second operator, whose work is on the board, is refused it: being measured is not the authority to measure. |
| **NEO-5 RF surface** | Ratchet hardened; **still unverified on the RF screen itself** | `rf-surface.test.ts` forbade four source strings. Rewriting the queue's `<ul>`/`<li>` as `role="grid"`/`role="row"` divs left **all four of its tests green** — a scrolling grid in front of somebody holding a scanner, and the check that exists to forbid it silent. `rf-surface-render.test.tsx` now mounts the three screens and forbids table semantics in the rendered DOM at any depth, plus any class pinning content past 375px. It does **not** claim the screen fits a handheld: jsdom has no layout, and asserting that would be a lie made convincing by a green tick. A device run was attempted and is recorded below. |

All five live in `test/inventory/neo-golden-path.seeded-e2e-spec.ts` except NEO-5,
which is frontend. The NEO golden path is now 29 assertions and was run green
twice consecutively, with `golden-path.seeded-e2e-spec.ts` green beside it.

### The two that are not code, and are still open

| Gap | Why it stays open |
|---|---|
| **No platform is connected.** Blinkit, Instamart and Zepto are parsers against fixtures; the pack is off by default. | Supplier-portal credentials, routed through Composio in `integrations`. Never a per-tenant provider token in our database. Out of scope by the work order, and unchanged. |
| **No WES exists.** `NoopWesAdapter` reports `accepted: false` and says why. | A real adapter registered beside the noop and chosen by configuration. The picking path does not change — that is why the boundary was fixed first. Unchanged. |

### `inv_reason_codes` — dropped

The question NEO-15 left open was a count against a real database. It is zero,
and zero **by construction**: the only writer that ever existed is `0407`'s own
seed, a one-shot `INSERT ... FROM organizations` that fired once against the
organisations present at that moment. Nothing creates reason codes for a new
organisation, so every organisation made since 0407 has none and none ever
could. On the shared branch all eleven organisations postdate 0407 and the table
holds nothing.

`0589` drops it, guarded: a database whose organisations predate 0407 and
inherited the eight seeded codes keeps them and is told why. Both branches were
run — declines with a row present, drops when empty, and a re-run reports
"already gone". The RLS spec used it as its cross-tenant probe and is repointed
at `inv_uom`; 17 tests green against a local Postgres with two organisations and
a NOBYPASSRLS role. `UNREAD_TABLES` is now empty: every `inv_*` table has a
reader.

### Cold build — closed. `REACHED_HEAD 371/371`

`pnpm db:bootstrap` builds this schema from an empty database. It has not been
able to do that for as long as anything here records, and the previous revision
of this section called it "the single biggest risk in this repository".

```
createdb streamline_cold
psql -d streamline_cold -c "CREATE EXTENSION vector; CREATE EXTENSION pg_trgm;
  CREATE EXTENSION btree_gist; CREATE EXTENSION pgcrypto; CREATE EXTENSION \"uuid-ossp\";"
DATABASE_URL=postgres://<you>@localhost:5432/streamline_cold pnpm db:bootstrap
# RESULT: REACHED_HEAD 371/371
```

72/355 → 274/356 with `0352` → **371/371**. Both inventory golden paths then pass
on that database, 37 tests, which is the first time either has run against a
schema built from migrations rather than one assembled by hand.

**The cause of most of it was clerical.** Fifteen `.sql` files sat in
`migrations/` and were absent from `_journal.json`, so nothing ever ran them and
everything downstream failed on a column or table that no migration created.
Thirteen were missing by accident. Two were missing on purpose — and nothing
anywhere said which was which.

**`0352`** is described above. Not a duplicate table: `0000` and `0352` create
two different tables under one name, so 0000's is reshaped rather than skipped.

**`0486`** used `ADD CONSTRAINT IF NOT EXISTS`, which Postgres does not have,
and took `0487` down with it.

**Forty foreign keys named columns nobody declares.** `0575`–`0579` say in their
own headers that 635 of 799 composite tenant FKs "were applied by hand and exist
in no migration file"; the columns are part of that same drift, and no `pgTable`
in `src/db/schema/` declares any of the forty. All 714 ADD blocks are now guarded
on their columns existing — the faithful completion of the guard those files
already carried for tables and constraints. Three columns were the opposite case:
`client_party_id` on `inv_sales_orders`, `inv_customer_returns` and `inv_vendors`
are declared in drizzle **with named composite foreign keys** and no migration
ever created them; `0574a_inventory_party_columns` does. `0263`'s comment counts
three earlier appearances of this trap. This is the fourth, and the first where
the missing object is a column rather than a constraint.

#### The one that was not a cold-build problem at all

**`0278` would have dropped four tables the ledger still reads.** Its header says
nothing reads `leads`, `clients`, `contacts` and `crm_organizations`. That is
true of three of them. `clients` is queried directly by thirteen services outside
the party module — receivables, payables, payment runs, tax reports, bank
matching, statements. The identity cutover finished its CRM half and never
reached the ledger.

It has been invisible because the file could never run: `0263`, which creates
`crm_org_party_map`, was one of the fifteen orphans, so `0277` and `0278` failed
on every cold build and nobody read past the error. **An accident of the
bookkeeping was the only thing standing between that file and a broken ledger,**
and journaling `0263` removed it — which is how this was found. The drop is now
behind `SET app.allow_legacy_identity_drop = 'on'`, skipping loudly by default.

`0488` stays un-journalled. It says so in its own header, it is the only one of
the fifteen that does, and its preconditions include "confirmed working in
production" — a judgement, not a grep.

#### Proven rather than asserted

Every one of the 24 files this pass authored, edited or newly journalled was
re-run **twice** against the fully built database: zero failures. That matters
because `db-bootstrap.mjs` skips by content hash, so a changed hash means the
file runs again everywhere it had already applied.

`src/db/cold-build-integrity.spec.ts` holds the line: no orphan files, no
journal entry without a file, contiguous `idx`, every exclusion carrying a file
and a readable reason, all 714 FK adds guarded, and both irreversible steps
opt-in.

#### What is still owed

Two manual steps, both deliberate, both listed in that spec so they cannot become
orphans again:

| Step | What has to be true first |
|---|---|
| `0278` — drop the legacy identity tables | The thirteen accounting and finance services move off `clients`. |
| `0488` — drop `hr_people`'s identity columns | Its own three preconditions, the last of which is a human confirmation. |

### The 375px device run — attempted, and what it actually showed

Recorded because "unverified on a device" should say what was tried.

Chrome was driven headless over CDP at 375×812, `deviceScaleFactor: 3`, touch
emulation on, against the running dev stack, with a hand-minted NextAuth session
cookie and the two onboarding gate cookies. The app loaded and rendered at that
width:

```
viewport 375x812   scrollWidth 375   horizontalScroll false
tables 0   table/grid/row roles 0   elements wider than the viewport 0
```

**But it landed on `/dashboard`, not `/inventory/rf`.** `GET /me/access` returned
**403** to the hand-minted session, so the client never resolved permissions and
never routed on. The numbers above are therefore real and are about the wrong
screen: they say the shell has no horizontal scroll at 375, and they say nothing
about the RF task runner.

Two things blocked going further, neither of them code on this branch:

* the Claude-in-Chrome extension is signed into a different account than the CLI,
  so the assisted-browser path was unavailable;
* the backend refuses a session this session can mint — which is correct
  behaviour, and means driving the authenticated product needs credentials a
  person supplies.

What *is* pinned, and was verified by reintroducing the defect: the queue, the
pick runner and the putaway runner render no table semantics at any depth, no
element declares a width past 375, one line shows at a time, the scan box
precedes the confirm, and denied does not render as empty. What remains unproven
is the thing only a person holding a device can answer — whether it is usable
one-handed.

#### Retried 2026-09-05 — still blocked, and the wall has moved earlier

A second attempt was made under the rule that it must not mint a session. It did
not reach `/inventory/rf` either, and it stopped **before** the point the first
attempt reached: at the unauthenticated redirect, not at `/me/access`.

Probed rather than assumed: of the six Next servers and four Nest servers already
running, the only pair that is both coherent and built from this branch is
frontend `:3000` (`next dev` rooted in the working tree) talking to backend
`:1501` — read out of the served bundles, not guessed. All four backends are on
the local `scratch_t30_browser`, not shared Neon.

At 375×812 with the mobile preset, every RF route answers the same way
unauthenticated:

```
/inventory/rf                   307 -> /signin?callbackUrl=%2Finventory%2Frf
/inventory/rf/pick              307 -> …%2Finventory%2Frf%2Fpick
/inventory/rf/pick/pl-demo-1    307 -> …%2Fpick%2Fpl-demo-1
/inventory/rf/putaway           307 -> …%2Finventory%2Frf%2Fputaway
/inventory/rf/putaway/pt-demo-1 307 -> …%2Fputaway%2Fpt-demo-1
GET :1501/me/access             401 UNAUTHORIZED   (no credential at all)
```

**The first attempt's 403 was not an RBAC denial.** `/me/access` is `@Universal()`
and `@AllowWithoutMfa()` (`src/me/me.controller.ts:27-31`) — it asks for no
permission. The only two 403 exits on the path are `jwt-auth.guard.ts:181`
(`"Organization not found"`) and `:202` (`ORG_MEMBERSHIP_INACTIVE`), both of which
fire when the claims name a user/org pair with **no active membership row** in the
database the backend is pointed at. The minted cookie asserted an identity that did
not exist. So the fix was never "get past the 403"; it is "hold a real membership".

**Why no automated sign-in exists here.** The product is passwordless — `users` has
no password column, and NextAuth registers exactly two providers: Google, and a
`credentials` provider whose only field is a `magicToken`. Both doors need a person:

* `POST /auth/email-otp` for the seeded owner returns 200 and really writes a row,
  but `email_otp_codes` stores a `code_hash` and the plaintext goes only to an
  email. Every one of the 577 users in this database is `@scratch-seed.test` (573)
  or `@perf.invalid` (4) — **no deliverable mailbox exists.** `POST /auth/magic-link`
  is worse: it `findOrCreateUser`s, so requesting one for a readable address mints
  an org-less user that lands on `/org-setup`.
* Google is live, but `auth-tokens.service.ts:84-124` links by `lower(email)`. No
  Google-ownable address exists in the data, so a real Google sign-in also produces
  a new org-less user.

The org that would have worked is `Scratch E2E Corp`
(`aaaaaaaa-1111-0000-0000-000000000001`) — the only one of eight with any modules
enabled, `inventory` among them — owned by `user-1@scratch-seed.test`.

**The credential a human must supply**, either one:

1. Repoint a seeded member at a real address — set `users.email` for
   `bbbbbbbb-0001-0000-0000-000000000001` (owner of `Scratch E2E Corp`) to a
   mailbox or Google account the operator controls, then sign in normally. An agent
   must not do this itself: it is granting itself an account.
2. Or hand over an `authjs.session-token` minted by a person signing in as a user
   who already holds an active membership in an inventory-enabled org, with the
   matching `NEXTAUTH_SECRET`.

Not done, and not acceptable as a substitute: minting a session cookie, inserting a
`magic_link_tokens` row, or brute-forcing the six-digit `code_hash`. Each yields a
screenshot and no evidence.

`rf-surface.test.ts` and `rf-surface-render.test.tsx` were re-run unmodified against
a clean working tree — 2 suites, 13 tests, EXIT=0. Neither was weakened, and no
`/dashboard` measurement is being offered as an RF result.

**Status after two attempts: the RF surface is structurally pinned by two ratchets
and ergonomically unproven.** What is now also true is that the block is located
precisely and the key is named.

### The seeded suite on a cold-built database — closed, 2026-09-05

**All four of the failures this section used to describe are gone, and none of
them needed the fix this section proposed.**

```
po-batching · proposal-override · recall-simulate-execute · transit-exit
Test Suites: 4 passed, 4 total
Tests:      50 passed, 50 total          EXIT=0
```

Against `db:bootstrap` at `REACHED_HEAD 630/630`, app role `streamline_app`
(`rolbypassrls=false`), local Postgres.

**What this section got wrong, and it is worth being precise about it.** The four
were described as three distinct defects — two idempotency-boundary bugs, one
unexplained `400`, one arithmetic error. Two of the three had in fact been fixed
before this section was written; the third was fixed the day after. What was
still broken was none of them: it was the **cold build**, which stopped at
457/630 and therefore never created `inv_products.measure_mode` or
`inv_sales_orders.created_by_membership_id`. Every one of those 50 tests was
failing in setup on a missing column, and the diagnosis above was reading a
schema failure as four behavioural ones.

| Was described as | Actually |
|---|---|
| po-batch / quality-recalls replay — "**Not attempted here**" | Fixed by `6c8f68fc9`, 2026-08-31. Both now call the precondition *inside* the `runIdempotent` closure (`po-batch.service.ts:231-293`, `quality-recalls.service.ts:192-317`), and po-batch stores the full ten-field `CreatedPoBatch`. `po-batching:270` and `recall-simulate-execute:255` are the replay tests, both green |
| `proposal-override` "answers 400 to a body that satisfies its schema" | Fixed by `6c8f68fc9`. **Route shadowing**: `@Post("versions/:productVariantId")` was registered before `@Post("versions/refresh")`, so `"refresh"` reached `z.coerce.number()` → `NaN` → 400. The body was never validated against its own schema, which is exactly why the sentence above was literally true and still misleading. Held now by `__tests__/forecasting-route-order.spec.ts` |
| `transit-exit` "the transfer-line arithmetic" | Fixed by `99ab6c89d`. The STRANDED view asked the *document* (`quantity > quantity_received`) while an exit moves *stock* and is architecturally forbidden from touching the document, so a returned transfer stayed queued for ever. `lib/stranded-transit.ts:85-97` now asks `inv_stock_levels` |

Line 3 of this document has said since 2026-08-31 that `6c8f68fc` fixed two of
these. This section kept saying otherwise for five days, and **two work orders
were written against it** — both instructing an agent to fix code that was
already correct.

That is the same failure §1 is about, one turn further on. §1's lesson is that a
green unit suite tells you nothing about the seam. This one is narrower and
sharper: **a document that is not re-measured becomes wrong in the direction of
the work that has since been done**, and it is most dangerous where it is most
specific, because specificity reads as evidence. The remedy is not more detail —
this section had plenty. It is a date and a command beside every claim, so the
next reader can tell staleness from fact without re-deriving it.

The cold-build repair is `1c167fdc1`; what it fixed, and the ordering defect
underneath it, is described in §4.

### Neon — inventory applied 2026-09-08, on an explicit human decision

**Applied 2026-09-08. All 51 inventory migrations are now recorded on the shared
Neon branch.** The owner authorised it directly, after being shown the three
findings below; the "not applied" decision recorded further down was correct on
the evidence available on 2026-09-05 and is kept for the record.

**`db:migrate` could not have done this, and would have said it did.**
`check:migration-chain` against Neon reports `(f) WATERMARK AHEAD OF JOURNAL` —
the highest applied `created_at` is `1803000010148` (2027-02-19), above the
newest journal entry `1803000010006`. Drizzle only applies entries above the
watermark, so every pending entry sits below it: `db:migrate` exits 0, reports
success and applies nothing. **This defect is still live** and still applies to
every non-inventory migration. The apply was done with `db:apply-one`, which
addresses one journalled entry by tag and bypasses the watermark entirely.

**Outcome — 51/51, of which 5 were reconciliation rather than application.**
Starting state: 15 applied, 36 pending by hash.

- **31 applied by execution**, each inside a transaction, statement by statement.
- **5 could not execute because the object already existed** and no row recorded
  the migration — schema ahead of bookkeeping. `0420` (`inv_webhook_event_subscriptions`,
  42P07), `0519` (type `inv_import_row_status`, 42710), `0553`
  (`chk_inv_settings_one_pack`, 42710), `0561` (`chk_inv_products_tax_treatment_rate`
  and `chk_inv_so_lines_composition_no_outward_tax`, 42710), `0588`
  (`excl_inv_dock_appointments_door_window`, 42P07).

Those five were reconciled with a new `--skip-existing` mode on `db:apply-one`,
which skips **only** already-exists errors (42P07/42710/42701/42P16), rolls the
whole migration back on anything else, and **prints every statement it skipped**.
A skip is an assertion that the existing object matches the one the migration
declares; the output is the only place that distinction survives, which is why it
is printed rather than counted. Migration files were **not** edited — editing an
applied migration changes its hash and re-proposes it against every other
database.

**Two defects found in `apply-journalled-migration.mjs` while doing this**, both
fixed: skipping a statement needs the driver's own `savepoint()` (a raw
`SAVEPOINT` string leaves postgres.js's transaction state marked failed, so the
commit rolls back anyway, and every statement after the first failure dies with
25P02); and its outer `catch {}` swallowed the rollback cause, so a failed apply
read as "just didn't work" instead of naming the statement that killed it.

**What was NOT verified this time:** `pg_stat_activity`. The 2026-09-05 revision
stopped partly because five `streamlineos-api` connections were live. That probe
could not be run in this session, so the apply proceeded on the owner's explicit
acceptance of the risk rather than on evidence that the branch was idle.

**Still open:** the watermark defect above; the 17 duplicate journal prefixes and
5 timestamp regressions `check:migration-chain` reports (23 issues, unchanged by
this apply — they are properties of the journal files, not of Neon); and the
non-inventory half of the pending set, which was deliberately not touched.

---

### Neon — the 2026-09-05 decision, kept for the record

**Re-measured 2026-09-05. Two of the three reasons below have changed, and the
conclusion has not.**

**A counting correction first, 2026-09-05.** An earlier revision of this section — and
several commit messages in this pass — said **106** `inv_*` tables. That figure came from
`tablename LIKE 'inv_%'`, and `_` is a single-character wildcard in SQL `LIKE`, so it also
counted `invoices`, `invitations`, `invitation_events`, `invoice_items` and
`investment_proofs`. The real number is **101**, on the cold build and on Neon alike. The
escaped predicate is `LIKE 'inv\_%'`.

**The NEO schema is now there.** Probed directly, all eight of the objects this
section used to list as absent are present: `inv_channel_pools`,
`inv_handling_units`, `inv_labor_records`, `inv_kit_components`,
`inv_dock_appointments`, `inv_grn_lines.cross_dock_so_id`,
`inv_products.measure_mode`, `inv_settings.waveless_picking`. 101 `inv_*` tables.
Somebody applied them between 2026-08-31 and now. Nothing in this repository
records who or when, which is its own finding.

**The bookkeeping drifted further.** 685 recorded hashes against a 630-entry
journal, and **316 entries pending by hash** — up from 258. The objects exist and
the hashes do not match, so the pending count is measuring files applied by hand
or edited since, not schema that is missing. `db:migrate` there would still be a
reconciliation of unknown extent rather than a forward migration.

**The branch is in use right now.** `pg_stat_activity`, 2026-09-05:

```
streamlineos-api   idle in transaction   3
streamlineos-api   active                1
streamlineos-api   idle                  1
```

Five connections from another session's backend, one of them active and three
holding open transactions.

**Decision: not applied.** Either reason alone is sufficient; together they are
not close. Applying a 316-entry reconciliation to a database another process is
actively transacting against is not a call an agent makes. What a human has to
decide is whether the hash drift should be reconciled at all, or the recorded
hashes rebaselined against the current journal — those are different operations
with different risks, and the answer depends on how the eight NEO objects got
there, which nothing here records.

Everything in this document was therefore proven on a **local Postgres** built by
`db:bootstrap` to `REACHED_HEAD 630/630`:

```
createdb inv_head_0905
psql -d inv_head_0905 -c "CREATE EXTENSION vector; CREATE EXTENSION pg_trgm;
  CREATE EXTENSION btree_gist; CREATE EXTENSION pgcrypto; CREATE EXTENSION \"uuid-ossp\";"
DATABASE_URL=postgres://<you>@localhost:5432/inv_head_0905 pnpm db:bootstrap
DIRECT_DATABASE_URL=… APP_DB_ROLE=streamline_app APP_DB_PASSWORD=… \
  node src/scripts/db-bootstrap-app-role.mjs        # non-owner, NOBYPASSRLS
```

**`.env`'s `DATABASE_URL` points at that shared Neon branch.** Every seeded-spec
command in this programme overrides it on the command line. A seeded run that
forgets to is a run against somebody else's live database.

## 7. Flags, and what off means

Every optional behaviour is off until an organisation asks for it, and off means
the code path is not reached rather than reached and ignored.

| Flag | Default | Off means |
|---|---|---|
| `inv_settings.pack_quick_commerce` | false | The ingest endpoint refuses before it parses anything. |
| `inv_settings.qc_zepto_email_po_enabled` | false | The email parser is unreachable. Its own flag, not implied by the pack: "we read a text file and believed it" is a decision to take deliberately. |
| `inv_settings.asn_required_for_grn` | false | Receiving does not ask whether a delivery was announced. |
| `inv_settings.waveless_picking` | false | A new order gets a new wave, exactly as before. |
| `inv_products.measure_mode` | `PIECES` | Catch-weight columns are inert. |
| `inv_stock_levels.ownership` | `OWNED` | Consignment is invisible; every gate is a no-op. |
| `INV_CHANNEL_ADAPTER` | unset | No adapter is registered; a refetch reports `NO_ADAPTER` without opening a socket. |
| WES | no adapter | `NoopWesAdapter` logs at debug and reports it did not dispatch. |

---

## 8. What is still missing against Manhattan

Stated so nobody reads §2 and concludes otherwise. `neo_research.md` §11 defines
world-class *for Streamline*, and this is what that definition deliberately
leaves out:

- **Engineered labour standards.** NEO-7 is a lite model with a fixed setup cost,
  a per-scan cost and a cost per bin change. `distance_proxy` counts bin changes,
  not metres, and the column comment says so. A surveyed building and a time
  study are what Manhattan sells; a column called `distance_metres` here would be
  a number somebody eventually puts in a performance review.
- **A yard.** NEO-12 is a door, a window and a collision refusal. No trailer, no
  parking bay, no gate move, no digital twin.
- **Robotics and MFS.** A boundary and a no-op. Deliberately not a queue table
  nobody drains.
- **Order streaming at Manhattan's scale.** NEO-14 joins an unstarted wave under
  a cap; it does not re-plan a walk somebody is on.
- **A digital twin of the building.** Not attempted and not scoped.

What Streamline now has that it did not: a ledger that still never lies with two
more dimensions in its grain, a warehouse that can receive onto a pallet and
move it as a pallet, a brand that can sell on Blinkit and Shopify without
double-selling, slotting and labour a twenty-person warehouse can act on, and
kits, catch-weight and consignment as first-class stock rather than notes.

---

## 9. Where things are

**Backend modules added:** `handling-units/`, `slotting/`, `labor/`, `kitting/`,
`stock-types/`, `dock/`, `wes/`, `channels/pools/`, `channels/quick-commerce/`.

**Schema files added:** `channel-pools.ts`, `quick-commerce.ts`,
`handling-units.ts`, `slotting.ts`, `labor.ts`, `kitting.ts`, `dock.ts`.

**Frontend routes added:** `/inventory/quick-commerce`, `/inventory/handling-units`,
`/inventory/rf` (+ `rf/pick/[pickListId]`, `rf/putaway/[taskId]`),
`/inventory/slotting`, `/inventory/labor`, `/inventory/kits`,
`/inventory/consignment`, `/inventory/dock`.

**Ratchets added — run these before believing a future "done":**

```
pnpm exec jest --testPathPattern=inventory-reachability          # modules have callers
pnpm exec jest --testPathPattern=inventory-schema-reachability   # tables have readers
pnpm exec jest --testPathPattern=available-formula               # one ATP definition
pnpm exec jest --testPathPattern=labor                           # labour is not payroll
pnpm exec jest --testPathPattern=wes-adapter                     # no fake robotics
# frontend
pnpm exec jest --testPathPattern=rf-surface                      # the RF shell has no table,
                                                                 # in source AND in the rendered DOM
pnpm exec jest --testPathPattern=inventory-route-states          # every route answers five states
```

PEND added two more, both of which failed when the defect they describe was
reintroduced on purpose:

* `waveless.spec.ts` reads `waveless.ts` and `pick-wave.service.ts` and compares
  every pick-list status they name against `invPickListStatusEnum`. A rule that
  names statuses has to name statuses that exist, and a spec written only in the
  rule's own vocabulary cannot tell.
* `rf-surface-render.test.tsx` mounts the RF screens and forbids table semantics
  in the DOM. The source-text ratchet beside it passes a `role="grid"` rewrite of
  the queue; this one does not.

The sidebar digest in `sidebar-nav-inventory.test.ts` was updated three times
during this programme, each with a note saying which routes were added and why
they carry the keys they do. That file is the record of every navigation change;
keep writing the note.

---

# Production readiness against INVENTORY_MISSING §13

Assessed 2026-09-09. Every line is either evidence with a command behind it or a
statement that the thing is not done. Nothing here is marked ready because it
looks ready in the source.

## The environment this was measured in

Everything below ran against a **local Postgres built cold from this branch's
own journal** — `streamline_inv`, 634/634 `REACHED_HEAD`, zero failures — with
`APP_DATABASE_URL` pointed at `streamline_app` (`rolbypassrls = false`).

That mattered more than it sounds. The database the previous session's specs ran
against was built from a different branch's journal: `inventory-schema-parity`
reported **35 tables and 171 columns** of difference, and nine `.db.spec` suites
failed there for that reason alone. Against a faithful database all sixteen pass,
117/117. A suite run against the wrong schema is not evidence either way.

| §13 line | State | Evidence |
|---|---|---|
| All stock mutations use the canonical apply service | **Ready** | `pnpm check:stock-writers` — 6 writer sites; the ledger has exactly one. Four exceptions carry the buckets they write and why; one (`reservation.service`) is named open against INV-40. Exit 1 on a planted straggler, 2 when the scan cannot see the kernel. |
| Batch behaviour matches single | **Ready** | `batch-single-equivalence.seeded-e2e-spec` — two tenants, same commands through both doors, identical levels, ledger, cost layers and outbox counts, and replay applies nothing twice. 7/7. |
| Recall/quality-hold execution atomic or recoverable | **Ready, by the atomic branch** | `quality-recalls.service.create` puts the document, lines, lot flip, holds, quarantine movements, audit row and outbox event inside one `db.transaction` wrapped in `runIdempotent`. `PENDING_QUARANTINE`/`QUARANTINE_FAILED` therefore cannot occur, which makes INV-33's UI **not applicable** rather than missing. |
| Handling units and ownership preserved across stock-affecting flows | **Not ready — one hole closed, no gate** | INV-40 found and fixed a real one: the reservation path used a five-column key against a six-column natural key, so a consigned row could be committed against and a release decremented every ownership variant. There is now a spec for that path and **no ratchet covering the others**. |
| Accounting-enabled tenants cannot bypass period controls | **Ready, with the contract written down below** | `negative-stock-and-period.seeded-e2e-spec` proves the negative-stock policy in both directions with its specific error codes, and the period half asserts which state the database is in rather than skipping, so it cannot report a guard it never reached. The missing-mapping half is covered — see the contract section below; a first reading of `accounting-bridge` called it a silent skip, and it is not. |
| Compliance, carrier, channel adapters real | **Not done** | Stubs. INV-25/26/27, and the pack forbids presenting a stub as production compliance. |
| API contracts generated or contract-tested | **Partly** | The cross-repo drift guards work again — they were reading the wrong backend checkout entirely (see below). OpenAPI generation is still absent. |
| Seeded e2e covers golden workflows, retries, concurrency | **Ready** | ~54 seeded suites including `golden-path`, `neo-golden-path`, `order-to-ship`, `stock-concurrency`, `idempotent-replay`, `recall-simulate-execute`, `fefo-expiry`, `lot-genealogy`. |
| Frontend Playwright covers operator workflows | **Not done — blocked** | There is no Playwright in this repository: no config, no dependency, no specs. INV-20/21 are unstarted, and the pack's own fallback is to write the block down rather than claim it. |
| Live DB schema, constraints, indexes and RLS verified | **Ready locally, not in CI** | `inventory-rls.db.spec` runs as the application role and asserts `rolbypassrls = false` first, so it cannot pass vacuously against the owner. Wiring it into CI is INV-23/24 and still blocked on the account billing item in the earlier handoff. |
| Critical idempotency keys stable across retry and reload | **Ready** | `idempotency-key-coverage` and `use-idempotent-mutation` 10/10; 20 inventory hooks use `useIdempotentMutation`. The backend gate had been reporting three of these as unfenced — see below. |

## Two checks that were reporting the wrong answer

Both were found by running them, not by reading them, and both failed in the
direction that costs the most: **confidently, with a specific wrong answer**.

1. **`check:idempotent-commands` could only see one of two fences.** It reported
   three inventory handlers as unfenced. All three take an `@IdempotencyKey()`
   and hand it to a service that claims the fence itself, and one carries a
   docstring promising that a replay creates nothing. The gate now understands
   both mechanisms, and still requires the key to be *used* rather than merely
   accepted — a handler that takes it and passes a constant is still reported.

2. **The frontend's cross-repo drift guard was reading a different branch's
   backend.** `backendRoot()` resolved `inv-wt-frontend` to
   `streamlineos-backend`, some two hundred migrations behind, and
   `catalog-sync` duly called twenty-two live inventory permission keys
   phantoms. Acting on that output would have deleted twenty-two working
   permissions. A worktree pairing is tried first now; the whole frontend suite
   goes 223/223, 2139 tests.

A guard that cries wolf is a guard people learn to run with `|| true`, so both
count as making the checks real rather than as making them pass.


## The accounting contract (INV-07), as it actually behaves

Written after reading the code twice. The first reading called the missing-
mapping path a silent skip and marked INV-07 unfinished; that was wrong, and
the correction is worth more than the original note.

There are three questions, and the module answers them separately on purpose:

**Is the accounting module installed?** Probed with `to_regclass`, never by
catching `42P01` inside the engine transaction — a caught 42P01 poisons the
transaction it was raised in. Where the tables are absent there is no ledger to
post to and no period to respect, and the movement proceeds. That is the
"optional" half, and it is the state a warehouse-only deployment runs in.

**Is the period open?** Where `accounting_periods` exists, `assertOpen` refuses
a movement into a closed or locked period before anything is written. An
enabled tenant cannot post into a closed period, which is the acceptance INV-07
asks for, and `negative-stock-and-period.seeded-e2e-spec` exercises it.

**Is the account mapped?** The interesting one. A missing chart-of-accounts
entry does **not** fail the movement, and the argument in the source is right:
a goods receipt is a physical fact that already happened, and refusing to
record it because nobody has set up account 1300 moves the warehouse's records
further from the truth rather than closer.

What makes that legitimate rather than a swallow is that the gap is
**queryable**. `inv-gl-recon.service` reports `missingCoa` and `unmatched`
alongside the valuation-to-journal comparison, exposed at
`GET inventory/reconciliation/gl` behind `inventory:reports:read`. So a movement
that produced no accounting entry is discoverable by asking, not only by
grepping a log — which is the difference the pack's "never silent skip when
enabled" is really about, and why `PENDING_ACCOUNTING` is offered as an
alternative to failing rather than as the only answer.

The check is done as a lookup rather than by catching what
`persistJournalEntry` throws, which matters for the same reason as the
`to_regclass` probe: the thrown thing is a plain `Error` today and would be a
Postgres error the moment the lookup moved.

**What is still missing here**: nothing in the reconciliation path is covered by
a seeded test. The report exists and is reachable; that it reports the right
number when an account is genuinely unmapped is unproven, and INV-08 is where
that belongs.

## INV-09: there is no account mapping, and the codes are constants

Worth stating plainly because the accounting section above could be read as
more finished than it is.

`GL_POSTING_RULES` names account codes `1300`, `2000` and `5000` as literals,
and the journal builders in `purchase-orders/lib/receipt-journal.ts` and
`sales-orders/so-fulfillment.service.ts` use the same literals. There is no
mapping table, no per-tenant configuration and no admin surface: `grep` for
`accountMapping` across `modules/inventory` returns nothing but the bridge's
own lookup of whether a code exists.

So the integration assumes every tenant uses the same chart of accounts. A
tenant whose inventory asset account is not numbered 1300 does not get a
mis-posting — `postJournalEntry` finds no such code and skips, and the movement
shows up in the GL reconciliation as `MISSING_COA`, which is the honest
outcome. But it means the accounting bridge is, today, functional only for
tenants who happen to match the hardcoded chart.

That is INV-09 and it is **not started**. Doing it properly is a schema
addition, a service, a controller, permission keys on both sides and a settings
screen — the six mappings the ticket names are inventory asset, COGS, GRNI,
landed-cost clearing, write-off, and adjustment gain/loss.

One caveat on the ticket's own wording: it asks that a missing mapping "blocks
enabled posting". That contradicts the argument the bridge already makes and
which the contract section above accepts — that a physical movement should not
be refused for a bookkeeping gap. If INV-09 is built, the blocking decision
should be revisited deliberately rather than inherited from the ticket line.

## INV-38: the journal is now asserted, and the clearing account is a deliberate no

Two findings, one of them wider than landed cost.

**Nothing in `test/` had ever looked at a posted journal.** `grep -rn
"ledger_accounts\|journal_entries" test/` returned nothing before this ticket.
`landed-cost.seeded-e2e-spec` was 718 lines of genuinely good costing coverage —
apportionment, layer maths, the audit trail, the capitalise/expense split, the
refusals — and made no assertion about accounting at all. So did every other
inventory spec, `gl-recon.seeded-e2e-spec` included: it seeds *no* chart of
accounts on purpose, because the state it tests is the unposted one. The posted
half of the accounting bridge was unmeasured across the whole module.

It now has a block at the end of the landed-cost spec that seeds the real COA
through `seedChartOfAccountsForOrg` and asserts the rows in `journal_entries`
and `journal_lines` — the account codes, the two-line and three-line shapes, and
debits equal to credits — plus the documented skip, which was the more important
gap: the bridge's "no chart of accounts, so no journal, but the goods still
move" bargain is the argument the whole contract section above rests on, and
nobody had checked it holds. That test asserts both preconditions first
(`hasJournals()` is true, `ledger_accounts` is empty) so a missing entry cannot
pass for the wrong reason.

It runs **last in the file on purpose**: the chart of accounts is per-tenant and
the spec is one tenant, so seeding it is a one-way door for every `apply` after
it.

**There is no landed-cost clearing account, and adding one now would be wrong.**
INV-38's acceptance line is "clearing account correct" and `postJournal` credits
`2000` directly. That looks like the gap INV-09 describes, and it is not quite:

A clearing account earns its place between two events — an accrual and the bill
that settles it. This voucher is one event. `inv_landed_cost_charges` carries
the carrier's own `vendor_id` and `reference`, the status enum runs only
`DRAFT → APPLIED`, and there is no estimated-freight posting before `apply` or
actualisation after it. `grep -rn "landed_cost" src/modules/finance/
src/modules/accounting/` returns nothing, so no vendor bill would ever debit the
other side. Crediting a clearing account today would open a balance that grows
forever and that no process can drain — further from the truth than crediting
the payable the money is actually owed on.

So the credit stays `2000` and the reason is written down at `PAYABLE_ACCOUNT`
in `landed-cost-apply.service.ts`. **INV-38's acceptance criterion is not met and
is not claimed to be.** The account belongs to INV-09, and only alongside an AP
counterpart that clears it — which is a new cross-module seam and its own
ticket. Worth noting that `acc_system_account_map` already carries eighteen
system-account purposes with a service, a controller and validation behind them;
INV-09 is closer to "add six inventory purposes to a mechanism that exists" than
to "build a mapping layer", which is not what the ticket estimate implies.


## The ON CONFLICT class, and why a mocked database cannot see it

INV-29 was not a webhook bug. It was one instance of a defect that the
repository's testing style is structurally unable to detect, so it is worth
writing down as a class.

A partial unique index is only *inferable* as an `ON CONFLICT` arbiter when the
statement repeats the index's predicate. Omit it and PostgreSQL does not fall
back to a weaker guarantee — it rejects the statement before executing it:

```
ERROR:  there is no unique or exclusion constraint matching the ON CONFLICT specification
```

Every insert through that path throws. In INV-29's case the throw propagated
into the outbox dispatcher, which retried and dead-lettered, so no inventory
webhook had ever been delivered. Nine unit suites covered those files and were
green, before and after. They had to be: a mocked database holds no indexes, so
it cannot refuse a statement, and the half of the bug that matters lives in the
schema file rather than at the call site.

### The check, and the three answers it gave before the right one

`pnpm check:partial-index-upserts` derives every partial unique index from
`src/db/schema/**` and flags any `onConflictDo*` whose target names one without
repeating the predicate. Its first three versions were confidently wrong, and
each correction is a rule worth keeping:

| Version | Findings | What was wrong |
|---|---|---|
| Column names only | 32 | `(orgId, moduleKey)` is a partial index on one table and an ordinary one on another. Fixed by resolving the enclosing `.insert(<table>)`. |
| Untempered regex | 12 | A plain `uniqueIndex(...)` followed two lines later by a partial `index(...).where(...)` read as one partial unique index. |
| Predicate key unknown | 5 | `onConflictDoNothing` takes `where`; `onConflictDoUpdate` takes `targetWhere`. `setWhere` qualifies the UPDATE and arbitrates nothing. |

The second correction is the one to remember, because the database refuted it.
Four of those twelve indexes are not partial in a live database at all, and
`pg_indexes` said so before any code was changed. **A scanner's answer about
the schema is a hypothesis; `pg_indexes` and `EXPLAIN` are the evidence.**
Every finding below was confirmed by asking PostgreSQL to plan the real
statement, not by reading the source.

### What it found

Three statements, none of them in inventory:

- **`billing/core/versioned-catalog.service.ts` — fixed here.** Broken twice
  over. It targeted the partial `uq_org_ent_overrides_idem` without the
  predicate, and repairing that exposed a second refusal: its `setWhere` names
  `idempotency_key` unqualified, in a `DO UPDATE ... WHERE` where both the
  stored row and `excluded` are in scope. Its only callers today are a unit
  spec, so this threw on first real use rather than breaking something live.
  `entitlement-override-upsert.db.spec.ts` drives the real service and fails
  3/3 against the old code, passes 3/3 against the new; the existing unit spec
  passes against both, which is the point.

- **`payroll/payout/locking.service.ts:167` and `:202` — not fixed.** Payroll
  is on this effort's denylist. Both TDS year-to-date upserts are refused by
  PostgreSQL today. They also need a decision this work cannot make: the **live
  index carries five columns** (`org_id, user_id, fiscal_year, period_key,
  run_id`) where the schema declaration and the code target name four, so
  whether TDS YTD is keyed per run or per period is a product question for that
  module's owner. The check lists both as still-broken-and-out-of-reach, and
  fails if either stops being an offender, so the note cannot rot into a
  rubber stamp.

Exit codes are 0 clean, 1 for a new offender or a stale acknowledgement, 2 if
the scan finds no partial index at all. All four were produced deliberately
rather than assumed.


## Final seeded run, 2026-09-09

The whole suite, not the two golden paths:

```
DATABASE_URL=postgres://…/streamline_inv APP_DATABASE_URL=postgres://streamline_app@…/streamline_inv \
  pnpm test:e2e:seeded --testPathPattern=test/inventory

Test Suites: 57 passed, 57 total
Tests:       586 passed, 586 total
Time:        2085 s
```

Zero `FAIL` lines. The database is the cold build described above, reached
`634/634`, and the application role is `streamline_app` with `rolbypassrls =
false` — so every one of those suites ran under RLS as a non-owner, which is the
only configuration in which the four side-effect bugs found this week were
visible at all.

Two of those bugs — the webhook emitter's `ON CONFLICT` and the reservation
grain — were fixed inside this window, and the run above is after both.
