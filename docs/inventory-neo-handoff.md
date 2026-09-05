# InventoryOS — NEO handoff

**Release pass — 2026-09-05. Pushed: backend `3d324061f`, frontend `3bbdfabe7`**, both on
`feat/inventory-world-class-implementation`. `main` untouched in both repos.

A ticketed close-out ran over this branch — 14 tickets, GitHub issues #34–#47 on the
frontend repo, label `inventory`. **Three of the four defects it was sent to fix were
already fixed**; §6 had been wrong for five days and two work orders were written against
it. What was actually broken was the cold build, and fixing that turned 50 failing tests
green without an inventory code change. The whole inventory seeded suite is now **51 suites,
561 tests, zero failures** on a database built from migrations alone — the previous best was
46/50 and 550/555, un-rerun for 27 commits.

Fixed here: the cold build (`1c167fdc1`); five commands that could not be retried, one of
them found by the ratchet after a hand sweep missed it (`310abf574`, `cd889bef7`); the
stranded-transit queue judging a transfer on somebody else's stock (`3d324061f`); and on the
frontend, the complete absence of error boundaries across 82 routed pages, eight missing
loading states, four URLs that 404'd, and no ratchet on nav→page (`3bac5faad`, `325d21660`,
`296d8bed2`, `3bbdfabe7`).

**Still needing a human.** Neon is not applied — five live `streamlineos-api` connections,
and 316 of 630 entries pending by hash against a database whose objects already exist, so
the decision is *reconcile or rebaseline*, not *run db:migrate*. RF is unproven on a device:
the product is passwordless and all 577 users have undeliverable addresses, so no automated
sign-in can exist; the surface is structurally pinned by two ratchets and ergonomically
unproven. Live Blinkit/Instamart/Zepto and a real WES remain secret-blocked, unchanged.

**Red that is not this branch's.** CI on both PRs is inherited from `main`: the backend
`Legacy org-actor ratchet` job sets a `backend/` working-directory that does not exist, and
Lint is 244 errors backend / 48 frontend, both main's. The frontend `type-check` failure is
five errors inside a **stale, gitignored `.next/types/validator.ts` generated Sep 4**, naming
routes that no longer exist — that gate currently measures build freshness, not type safety.
And **none of the ratchets this pass added run in CI**; a gate nobody runs is a comment.

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
createdb cornerstone_neo16
psql -d cornerstone_neo16 -c "CREATE EXTENSION vector; CREATE EXTENSION pg_trgm;
  CREATE EXTENSION btree_gist; CREATE EXTENSION pgcrypto; CREATE EXTENSION \"uuid-ossp\";"
# then apply migrations/*.sql in journal order
DATABASE_URL=postgres://<you>@localhost:5432/cornerstone_neo16 \
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
> `0574_inventory_party_columns` creates them — the result is **46 pass, 4 fail**
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
| `0580_inventory_channel_pools` | `inv_channel_pools`; `inv_sales_orders.channel_id`. |
| `0581_inventory_quick_commerce_asn` | Platform POs, ASNs, payout lines; `inv_channels.qc_provider`; `inv_grns.asn_id`; three settings flags; `inv_sales_orders.platform_po_id`. |
| `0582_inventory_handling_units` | `inv_handling_units`; `handling_unit_id` on levels, transactions, reservations, pick lines and GRN lines; **the natural-key index is dropped and recreated**. |
| `0583_inventory_slotting` | Slotting rules, velocity classes, re-slot recommendations. |
| `0584_inventory_labor` | `inv_labor_records`; the `inventory:labor:read` backfill. |
| `0585_inventory_cross_dock` | `inv_grn_lines.cross_dock_so_id`. |
| `0586_inventory_kitting` | `inv_kit_components`; four `inv_txn_type` labels; the `inventory:kits:assemble` backfill. |
| `0587_inventory_catch_weight_consignment` | `measure_mode`, `quantity_pieces`, `ownership`; **the natural-key index is dropped and recreated again**. |
| `0588_inventory_dock_waveless` | Dock doors and appointments with the exclusion constraint; two waveless settings; the `inventory:dock:manage` backfill. |
| `0589_inventory_drop_reason_codes` | PEND-15. Drops `inv_reason_codes`, guarded on the table being empty. |

`0574_inventory_party_columns` also belongs here in spirit: it adds the three
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
createdb cornerstone_cold
psql -d cornerstone_cold -c "CREATE EXTENSION vector; CREATE EXTENSION pg_trgm;
  CREATE EXTENSION btree_gist; CREATE EXTENSION pgcrypto; CREATE EXTENSION \"uuid-ossp\";"
DATABASE_URL=postgres://<you>@localhost:5432/cornerstone_cold pnpm db:bootstrap
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
ever created them; `0574_inventory_party_columns` does. `0263`'s comment counts
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

### Neon — still not applied, for a different reason than before

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
