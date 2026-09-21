# QA Bug → canonical BUG work item — migration and backfill design

**Backlog item:** P0 #7 · **Branch:** `build/final-n-bugs` · **Worktree:** `slos-be-n-bugs`
**Date:** 2026-09-22

> **STATUS: DESIGN ONLY. NOTHING HERE HAS TOUCHED A DATABASE.**
> No PostgreSQL was reachable from this machine and none was contacted. Every claim is
> either **verified by reading source at the cited line** or **verified by running a
> gate that performs no database I/O**. The SQL below is authored and internally
> consistent; it is **unexecuted**. See §10 for exactly what that leaves unproven.

---

## 1. What is actually true today

Verified at source. Where the brief that commissioned this document was wrong, the
correction is marked **CORRECTION**.

### 1.1 Two identities, linked

| | Canonical work item | QA bug |
|---|---|---|
| Table | `build.tickets` (`src/db/schema/build/ticket-core.ts:26`) | `build.bugs` (`src/db/schema/build/qa.ts:138`–`188`) |
| Type discriminator | `tickets.type` (`ticket-core.ts:35`), `ticket_type` = `EPIC STORY TASK BUG` (`src/db/schema/common/enums.ts:17`) | — the table *is* the type |
| Number | `ticket_number`, unique per project via `uniq_tickets_project_number` (`ticket-core.ts:100`) | `bug_number`, unique per project via `uq_bugs_project_number` (`qa.ts:174`) |
| Number source | `build.project_ticket_counters`, reserved by `allocateTicketNumbers` (`src/modules/build/core/lib/allocate-ticket-number.ts:6`–`32`) | `MAX(bug_number)+1` under `pg_advisory_xact_lock` (`src/modules/build/qa/bugs.service.ts:59`–`64`) |
| Status | `text`, FK'd to per-project rows (below) | `bug_status` enum, 9 values (`qa.ts:136`) |
| Priority | `ticket_priority`, 4 values (`enums.ts:19`) | `bug_priority`, 4 values (`qa.ts:135`) |
| Severity | **none** | `bug_severity`, 5 values (`qa.ts:134`) |

The link: `bugs.linked_ticket_id` (column `qa.ts:160`, FK `fk_bugs_org_ticket` at `qa.ts:171`,
`ON DELETE SET NULL`) and `test_run_results.linked_bug_id` (column `qa.ts:119`, FK
`fk_test_run_results_org_bug` at `qa.ts:124`, `ON DELETE SET NULL`).

**CORRECTION — the brief cited `qa.ts:171` as the column.** `:171` is the foreign key.
The column is `:160`. Same for `test_run_results.linked_bug_id`: column `:119`, FK `:124`.

### 1.2 The ten QA-only columns

`steps_to_reproduce` (`qa.ts:148`), `expected_result` (`:149`), `actual_result` (`:150`),
`environment` (`:151`), `browser_device` (`:152`), `affected_release_id` (`:153`),
`fixed_release_id` (`:154`), `qa_owner_membership_id` (`:158`), `reopen_count` (`:159`),
`linked_test_case_id` (`:161`). Confirmed: `tickets` has no counterpart for any of them
(`ticket-core.ts:29`–`79`).

Two more columns are QA-only in practice and the brief did not count them, because they
*look* like they have ticket counterparts and do not:

- `bugs.severity` (`qa.ts:145`) — see §4.
- `bugs.qa_owner_id` (`qa.ts:157`), a `text` FK straight to `users`. It is the legacy
  half of the actor contraction and is **not** carried forward; see §1.5.

### 1.3 The status foreign key — the constraint that decides §3

```
fk_tickets_status  FOREIGN KEY (org_id, project_id, status)
  REFERENCES project_statuses (org_id, project_id, name) ON UPDATE CASCADE
```

`src/db/schema/build/ticket-core.ts:95`–`99`. `project_statuses` is a per-project,
user-editable table (`src/db/schema/build/core.ts:132`–`152`) whose `name` is free text
(`core.ts:139`) and whose `type` is `state_group` = `backlog unstarted started completed
cancelled` (`enums.ts:24`). `DEFAULT_PROJECT_STATUSES` (`src/modules/build/core/lib/
default-statuses.ts`) seeds `TODO / IN_PROGRESS / IN_REVIEW / DONE` **and is only a seed** —
a project may rename or replace every row.

**This is the single most important fact in this document.** Any backfill that writes a
literal `'TODO'` or `'DONE'` into `tickets.status` raises `23503` on the first project
that renamed its board. The mapping must resolve through `project_statuses`, not around it.

### 1.4 Backend surface — narrower than described, and one claim overstated

Non-spec files touching `bugs`: `src/db/schema/build/qa.ts`,
`src/modules/build/qa/bugs.controller.ts` (109 lines),
`src/modules/build/qa/bugs.service.ts` (201 lines),
`src/modules/build/qa/test-runs.service.ts` (429 lines, one bug-creating method),
`src/modules/build/qa/build-qa.module.ts`,
`src/modules/build/qa/dto/bugs.schemas.ts`,
`src/modules/build/qa/dto/qa-response.schemas.ts:108`–`136`,
`src/modules/rbac/permissions/build.ts:56`–`77`,
`src/modules/organization/core/membership-artifact-catalog/build.artifacts.ts:114` and `:195`.

**CORRECTION — `docs/build-module/C-D-CLOSURE-HANDOFF.md` does not exist.** It is absent
from this worktree and from `D:/projects/personal/Streamlineos/backend`. `docs/build-module/`
contains exactly two files in both trees (`authorization-census.json`, `authorization-census.md`).
Its claims were therefore checked directly against `bugs.service.ts`:

| Claimed | Verdict | Evidence |
|---|---|---|
| list / get / create / update / soft-delete exist | **True** | `bugs.service.ts:20, 42, 56, 113, 183` |
| project + org predicates on every path | **True** | `assertProjectAccess` at `:21, 43, 57, 119, 184`; `eq(bugs.orgId, …)` + `eq(bugs.projectId, …)` on each |
| reopen counting implemented | **True** | `:130` sets `isReopening`, `:164` increments |
| **status transitions implemented** | **FALSE** | `:150` writes `input.status` unconditionally. There is no transition table, no guard, no rejection. `closed → new` is accepted. The only status-aware code in the file is the reopen counter at `:130`. |

So "remaining work" is larger than the handoff implies by exactly one thing: status
transition validity was never implemented and must be designed in, not ported.

### 1.5 Two live defects found while verifying

**(a) `bugs.qa_owner_membership_id` is written by nobody.** `bugs.service.ts:94` writes
`qaOwnerId` on create and `:161` writes it on update. Neither path ever writes
`qaOwnerMembershipId`. The column was populated once, by the backfill in
`migrations/0908_build_actor_backfill.sql:145`–`150`; every bug created since has a QA
owner whose membership pointer is `NULL`. The membership artifact catalog entry
`bugs_qa_owner_membership` (`build.artifacts.ts:195`–`202`) rules on a pointer that no
write path maintains, and `idx_bugs_org_qa_owner_membership` (`qa.ts:177`) indexes a
column that is mostly `NULL`. The backfill in §7.3 repairs this on the way across
(`COALESCE(b.qa_owner_membership_id, om.id)`); the rewritten service must resolve the
membership the way `assigneeMembershipId` already is at `bugs.service.ts:65`–`74`.

**(b) `bugs.service.ts:33` searches with a leading-wildcard `ILIKE`** —
`ilike(bugs.title, '%' + q + '%')`. That is BE-49 ("Search with `to_tsvector` + GIN or
`pg_trgm`. Never a leading-wildcard `ILIKE`"). Consolidating onto the tickets explorer
retires it for free, because the canonical search path is already built. Recorded so the
rewrite does not carry it over.

### 1.6 Frontend — decoupled, which the brief got backwards

**CORRECTION — the QA test-case/test-run surfaces are NOT in the bugs directory.**

- `frontend/features/build/bugs/` holds exactly four files: `bug-schema.ts`,
  `bug-sheet.tsx`, `bugs-page.tsx`, `bugs-page.test.tsx`.
- `frontend/features/build/qa/` holds `qa-page.tsx`, `qa-schema.ts`, `test-cases-tab.tsx`,
  `test-case-columns.tsx`, `test-case-sheet.tsx`, `test-run-sheet.tsx`,
  `test-runs-tab.tsx`, and `runs/`.

They are separate directories. The only coupling is `features/build/qa/runs/result-row.tsx`
and `runs/run-execution-page.tsx`, which render a "Create Bug" action and a
`/build/{projectId}/bugs` deep link (`result-row.tsx:103`, `:140`–`148`;
`run-execution-page.tsx:108`).

This makes the consolidation **cheaper and lower-risk than the brief assumed**: the QA
surfaces survive by not being touched. Only two files in `features/build/qa/runs/` need
their link and mutation retargeted. `features/build/bugs/` is replaced wholesale.

### 1.7 RLS

`bugs` carries a `tenant_isolation` policy. It was installed by
`migrations/0378_rls_remaining_tenant_tables.sql`, which is catalog-driven and
deliberately unfiltered — it enables RLS on *every* `public` relation with a `text`
`org_id` (`0378:17`–`27`) — and survived the move to the `build` schema, because
`migrations/0432_build_schema.sql:4` records that `SET SCHEMA` is catalog-only and "FKs,
indexes, owned identity sequences and RLS policies follow".

**This is inference from reading, not verification.** BE-72 names `pnpm db:verify-rls` as
the authority and it cannot run here. The new tables in §7.1 and §7.2 therefore install
their policy and grants **explicitly**, in the shape of
`migrations/1137_employee_support_queues.sql:96`–`107`, rather than relying on a
catalog-driven migration that already ran once and will not run again.

---

## 2. Decision 1 — where the QA-only fields live

### Recommendation: a 1:0..1 extension table, `build.ticket_bug_details`, keyed `(org_id, ticket_id)`.

Four options were considered.

**(a) Widen `tickets` with 12 columns.** Rejected. `tickets` is the hottest table in the
module and its index layout is already tuned to the byte: the comment at
`ticket-core.ts:119`–`128` records that putting one extra column between `rank` and `id`
in `idx_tickets_org_project_rank` made every board page Incremental-Sort the whole
project. Five text columns plus seven scalars, `NULL` on every `EPIC`, `STORY` and `TASK`
row, widen the heap tuple for readers who will never project them. There is also no way
to express "only `type = 'BUG'` rows may carry these" — twelve `CHECK` constraints or
nothing.

**(b) A JSONB blob on `tickets`.** Rejected by **BE-42**: "Normalize lifecycle entities
into tables. Never a JSONB array. *Why:* cannot be indexed, paginated or soft-deleted."
A bug's QA state is a lifecycle, not an attribute bag. Concretely, JSONB destroys four
things this design needs: `severity` is a filter and sort dimension with a live index
(`idx_bugs_org_project_severity`, `qa.ts:173`); `affected_release_id` and
`fixed_release_id` are composite tenant FKs to `project_releases` (`qa.ts:167`, `:168`);
`qa_owner_membership_id` is a composite tenant FK that the membership artifact catalog
rules on (`build.artifacts.ts:195`); `linked_test_case_id` is a composite tenant FK to
`test_cases` (`qa.ts:170`). Referential integrity cannot live inside a JSONB document.

**(c) A polymorphic `work_item_details(entity_type, entity_id, …)`.** Rejected by
**BE-43**: "Ban `entity_type` + `entity_id` on new tables. Use an exclusive arc or a link
table per relationship." It is also unnecessary — there is exactly one relationship here.

**(d) `build.ticket_bug_details`, one row per BUG ticket, PK `(org_id, ticket_id)`.**
**Recommended.** This *is* what BE-42 prescribes: the QA lifecycle normalized into a
table. It satisfies BE-43 by being a link table for one relationship to one parent, with
a real composite FK to `tickets(org_id, id)` (`uniq_tickets_org_id`, `ticket-core.ts:143`)
rather than a type tag. Every column keeps its real type and its real foreign key. The
table is small — one row per bug, not one per ticket — so `severity` and `qa_status`
indexes cost a fraction of what they would on `tickets`. BE-38 is satisfied (`org_id`
non-nullable and index-leading); BE-44 is satisfied (`org_id` leads every composite index);
BE-45 is satisfied (every FK indexed).

**No `deleted_at` on the extension table.** BE-50 asks for `deleted_at` on new *business*
tables; this is a detail record whose lifecycle is its parent's. Two independent
`deleted_at` columns on a 1:1 pair is the split-brain BE-54 exists to warn about — a
soft-deleted parent never cascades, so the pair would silently diverge. Reads filter
`tickets.deleted_at IS NULL` on the join, once.

**Column list (13 payload columns):** the ten named in §1.2 as-is, plus `bug_number`
(§5), `qa_status` (§3) and `severity` (§4). `qa_owner_id` is deliberately dropped (§1.5a,
and BE-46 — `tickets` already reaches people through `organization_members`).

---

## 3. Decision 2 — status mapping

`bug_status` has nine values. `tickets.status` is not an enum; it is a `text` column
constrained to that project's own `project_statuses.name` (§1.3). There is no fixed target
vocabulary to map *to*.

### 3.1 The mapping is two-stage, and the second stage is resolved per project at backfill time

**Stage 1 — `bug_status` → `state_group`** (`enums.ts:24`). This is a fixed, total function:

| `bug_status` | `state_group` | Why |
|---|---|---|
| `new` | `backlog` | Raised, not triaged. Nothing has been decided. |
| `triaged` | `unstarted` | Accepted into the plan, no work begun. |
| `assigned` | `unstarted` | Owner exists, no work begun. |
| `in_progress` | `started` | |
| `fixed` | `started` | **Not `completed`.** A fix that QA has not verified is work in flight; `reopened` exists precisely because `fixed` is not terminal. Mapping it to `completed` would close bugs that are not closed. |
| `ready_for_qa` | `started` | |
| `reopened` | `started` | |
| `verified` | `completed` | |
| `closed` | `completed` | |

**Stage 2 — `state_group` → a name that exists in *this* project.** Resolved by lookup, not
by literal:

```sql
COALESCE(
  (SELECT ps.name FROM build.project_statuses ps
    WHERE ps.org_id = :org AND ps.project_id = :proj AND ps.type = :group
    ORDER BY ps."order", ps.id LIMIT 1),
  (SELECT ps.name FROM build.project_statuses ps
    WHERE ps.org_id = :org AND ps.project_id = :proj
    ORDER BY ps."order", ps.id LIMIT 1)
)
```

The first branch takes the project's own leftmost column of the right kind. The fallback
takes the project's leftmost column of any kind, so a project that has no `backlog`
column still receives a valid, FK-satisfying status instead of `23503`. On a project that
kept the seed (`default-statuses.ts`), the resolution collapses to
`backlog → TODO`, `unstarted → TODO`, `started → IN_PROGRESS`, `completed → DONE` —
because `TODO` is `unstarted` and no seeded row is `backlog`, so `new` falls through the
first branch to the second and lands on `TODO` (order 0). That is the intended answer.

A project with **zero** `project_statuses` rows cannot hold a ticket at all. Migration
1145 asserts this up front and raises with the offending list rather than skipping
silently.

### 3.2 What happens to values with no counterpart — all nine of them

Stage 1 is nine-to-four. Five values (`new`, `triaged`, `assigned`, `ready_for_qa`,
`reopened`) are QA-workflow states with no project-status equivalent anywhere in the
product, and the other four are only coincidentally close. **Collapsing them would be a
silent data loss of the exact kind this consolidation is supposed to stop.**

So the original value is preserved verbatim:
`ticket_bug_details.qa_status public."bug_status" NOT NULL`, reusing the existing type.
`tickets.status` drives the canonical board; `qa_status` drives the QA lane on `/bugs`.
Nothing is discarded, and the round trip is lossless in the direction that matters
(`qa_status` → `tickets.status` is a pure function; the reverse is not, and is never
computed).

**`cancelled` is unreachable.** No `bug_status` value means "won't fix", "not a bug" or
"duplicate — closed". That is a gap in `bug_status`, not in this mapping. The
consolidation is the right moment to add `wont_fix` and `not_a_bug` to the QA lane and
map both to `cancelled`; that is a follow-up, listed in §11, not smuggled into the
backfill.

### 3.3 Transition validity

There is none today (§1.4). The rewritten service (§8) introduces one, as an adjacency
map over `qa_status`, enforced in the service and not in the database — a `CHECK` cannot
see the previous value, and a trigger would be invisible to the reader of the service.
The reopen counter at `bugs.service.ts:130` becomes a consequence of the
`* → reopened` edge rather than an independent conditional.

---

## 4. Decision 3 — severity

`bug_priority` (`qa.ts:135`, 4 values, lowercase) maps **1:1 and losslessly** onto
`ticket_priority` (`enums.ts:19`, 4 values, uppercase): `upper(priority::text)`. Priority
moves onto `tickets.priority` and needs no new storage.

`bug_severity` (`qa.ts:134`) has five values and **no counterpart**. It is orthogonal to
priority — a `trivial` bug can be `URGENT` (a one-character typo on the pricing page) and
a `blocker` can be `LOW` (a crash in a feature nobody has shipped yet). Every one of the
20 combinations is meaningful.

**Decision: `severity public."bug_severity" NOT NULL DEFAULT 'major'` on
`ticket_bug_details`.** Not on `tickets`, not a label.

- **Not a new column on `tickets`** — it is meaningless on 3 of the 4 ticket types, and
  `tickets`' index budget is contested (§2a). The existing
  `idx_bugs_org_project_severity` (`qa.ts:173`) becomes
  `idx_ticket_bug_details_org_severity` on a table one-Nth the size.
- **Not a label** (`build.ticket_labels`, `src/db/schema/build/ticket-collaboration.ts:111`).
  Labels are free-form, per-org, unordered and multi-valued. Severity is a closed, ordered,
  single-valued scale. Modelling it as a label would make `severity = blocker` a string
  match against a row a user can rename or delete, and would lose the ordering that every
  QA triage view sorts by. It would also be BE-42 by another route: a lifecycle dimension
  stored as an unconstrained association.
- **Not collapsed into priority.** Explicitly rejected. Two orthogonal axes, one column,
  is an unrecoverable merge.

The existing `public."bug_severity"` type is reused. No `CREATE TYPE`, therefore no
`DROP TYPE` obligation in any rollback, therefore no exposure to the 0143-class mismatch
that `check:migration-rollback` catches (`src/scripts/check-migration-rollback.mjs:11`–`12`,
`:197`–`203`).

---

## 5. Decision 4 — the numbering collision

`bugs.bug_number` and `tickets.ticket_number` are independently unique per project
(`qa.ts:174`, `ticket-core.ts:100`). Project 7 can hold bug #3 and ticket #3 simultaneously.
They cannot be merged by keeping the number.

### 5.1 Migrated bugs are renumbered from the canonical counter

Per project, before inserting, reserve a contiguous block of `n` ticket numbers using the
**same statement the application uses** (`allocate-ticket-number.ts:14`–`26`):

```sql
INSERT INTO build.project_ticket_counters (org_id, project_id, next_ticket_number)
SELECT :org, :proj, COALESCE(MAX(ticket_number), 0) + :n + 1
FROM build.tickets WHERE org_id = :org AND project_id = :proj
ON CONFLICT (org_id, project_id) DO UPDATE
  SET next_ticket_number = GREATEST(
        project_ticket_counters.next_ticket_number,
        EXCLUDED.next_ticket_number - :n
      ) + :n,
      updated_at = now()
RETURNING next_ticket_number - :n AS start;
```

Collision is impossible by construction, twice over: the seed arm reads the live
`MAX(ticket_number)` from `tickets`, and the conflict arm's `GREATEST` keeps the counter
monotone against a row that already exists. The reserved block is then handed out in
`bug_number ASC` order, so relative ordering survives the renumber:
`ticket_number = start + row_number() OVER (ORDER BY bug_number) - 1`.

This is deliberately not a bespoke allocator. Using the production statement means the
backfill and a concurrent `POST /build/:id/tickets` cannot disagree about what is next.

### 5.2 The old number is preserved, and it is user-visible

`ticket_bug_details.bug_number integer NOT NULL`, with
`uq_ticket_bug_details_project_bug_number` — a **unique index on `(project_id, bug_number)`**
mirroring `uq_bugs_project_number`, so the historical numbering stays a real key rather
than a note. `project_id` is denormalized onto the detail row for exactly this index (and
so the index can serve project-scoped QA lists without a join).

It is surfaced: the `/bugs` explorer renders it as a secondary identifier
(`BUG-14 → TICKET-207`), and the read contract publishes it. A QA engineer who wrote
"see BUG-14" in a comment three months ago can still find the row. **Answering the
question as asked: yes, existing bug numbers are preserved, in a dedicated indexed
column, visible in the UI and in the API response.**

---

## 6. Decision 5 — `test_run_results.linked_bug_id` and the dedup rule

### 6.1 Repointing

Add `test_run_results.linked_ticket_id integer` (nullable), backfill it through the
migration map, then add the composite tenant FK to `tickets(org_id, id)` — `NOT VALID`,
then `VALIDATE`. `linked_bug_id` is **not** dropped in the same release; see §7.7.

Because every bug gets exactly one map row (§6.2), every non-`NULL` `linked_bug_id`
resolves to exactly one `linked_ticket_id`. There is no unresolvable case — including for
soft-deleted bugs, which are migrated too, precisely so this mapping is total.

### 6.2 The dedup rule for bugs that already have a linked ticket

For each bug, exactly one disposition, recorded in `build.bug_ticket_migration_map`:

**`adopted`** — `linked_ticket_id IS NOT NULL`, the target ticket exists, is **not**
soft-deleted, is in the **same project**, and this bug has the **lowest `bug_number`**
among all live bugs pointing at that ticket.
→ **No new ticket is created.** The existing ticket is forced to `type = 'BUG'` (its prior
type is recorded in the map so the rollback can restore it) and the `ticket_bug_details`
row is attached to it. **Its `title`, `description`, `status`, `priority`, `assignee` and
`rank` are left completely alone.** The ticket is the live record that people have been
working; the bug row is the annotation. Overwriting a ticket's status with a bug's mapped
status would destroy board state.

**`created`** — everything else. A new `BUG` ticket is created (§5.1), carrying
`title`, `description`, mapped `status`, uppercased `priority`, `assignee_membership_id`,
`reporter_id`, `deleted_at`, `created_at` and `updated_at` from the bug row.
This covers four cases, each deliberate:

1. `linked_ticket_id IS NULL` — the ordinary case.
2. The target ticket is **soft-deleted**. BE-54: a soft-deleted parent never fires the
   child's cascade, so the FK did not null the pointer. Adopting a deleted ticket would
   resurrect it. Create instead.
3. The target ticket is in a **different project**. `fk_bugs_org_ticket` (`qa.ts:171`) is
   `(org_id, linked_ticket_id)` with no project predicate, so cross-project links are
   representable and may exist. The new ticket is created in the **bug's own** project —
   that is where its `bug_number`, its releases and its test cases live — and a
   `work_item_relations` row of type `relates_to` records the cross-project link.
4. **A lower-numbered bug already adopted that ticket.** This is the collision case: N
   bugs pointing at one ticket, and `ticket_bug_details`' PK `(org_id, ticket_id)` admits
   exactly one. The lowest `bug_number` adopts; the rest are created as their own tickets
   and joined to the adopter with `work_item_relations(relation_type = 'duplicate_of')`
   (`enums.ts:29`, table at `ticket-core.ts:157`). **Nothing is dropped, nothing is
   merged, and the choice is deterministic** — `bug_number` is unique per project
   (`uq_bugs_project_number`) so there is no tie to break.

Soft-deleted bugs are always `created`, never `adopted`, and carry their `deleted_at`
across so they land as soft-deleted tickets.

---

## 7. The migration sequence

Journal head is `idx 1030`, tag `1142_fix_requisition_headcount_fk_set_null`,
`when 1803000010420` (`migrations/meta/_journal.json`, last entry). 1141 and 1142 are
authored and **UNAPPLIED**. These six append after them.

| # | Tag | `idx` | `when` | Purpose |
|---|---|---|---|---|
| 1143 | `ticket_bug_details` | 1031 | 1803000010430 | create the extension table, RLS, grants |
| 1144 | `bug_ticket_migration_map` | 1032 | 1803000010440 | create the durable backfill ledger |
| 1145 | `backfill_bug_tickets` | 1033 | 1803000010450 | the batched backfill |
| 1146 | `ticket_bug_details_not_null` | 1034 | 1803000010460 | seal three columns `NOT NULL` |
| 1147 | `test_run_results_linked_ticket` | 1035 | 1803000010470 | add the nullable pointer + FK |
| 1148 | `backfill_test_run_results_linked_ticket` | 1036 | 1803000010480 | repoint results |
| — | `retire_bugs` | — | — | **deferred, deliberately not authored** — §7.7 |

Each `.sql` needs its `_journal.json` entry (`version: "7"`, `breakpoints: true`) —
BE-58, and `check:migration-discipline` check 6 fails the gate without it.

### 7.0 House-rule compliance, and one rule that is wrong

| Rule | How this sequence satisfies it |
|---|---|
| BE-61 nullable → batched backfill → NOT NULL | 1143 (nullable) → 1145 (batched) → 1146 (`NOT NULL`). Three migrations, one purpose each. |
| BE-62 FK `NOT VALID` then `VALIDATE` | Every `ADD CONSTRAINT … FOREIGN KEY` below is `NOT VALID`, with `VALIDATE` in a separate statement. `check:migration-discipline` check 2 enforces it. |
| BE-63 `CHECK … NOT VALID` → `VALIDATE` → `SET NOT NULL` → drop `CHECK` | 1146, three times. Check 3 enforces it. |
| BE-64 `lock_timeout` | `SET lock_timeout = '5s';` heads every file. Check 1 enforces it. |
| BE-68 `statement_timeout = 0` on heavy `DO` blocks | 1145 only. |
| BE-71 rollback for every destructive step | Six `.down.sql` files, all below. |
| — `--> statement-breakpoint` inside `DO $$` | Never. `check-migration-discipline.mjs:551`–`561`, baseline empty. |

> ### ⚠️ **BE-65 contradicts the gate that enforces it, and the gate wins.**
>
> The brief instructed "`CONCURRENTLY` indexes (BE-65)". **Following that instruction
> would fail CI.** `CLAUDE.md:90` says "Build indexes concurrently on large tables";
> `src/scripts/check-migration-discipline.mjs:569`–`574` is check 7, which **rejects any
> migration containing `CREATE [UNIQUE] INDEX CONCURRENTLY`**, with the reason: "cannot
> run inside drizzle-kit migrate's transaction wrapper — use `CREATE INDEX` (without
> `CONCURRENTLY`) and rely on `lock_timeout` to fail fast instead of queuing." The
> baseline set `BASELINE_CONCURRENTLY` is **empty** (`:329`), so the corpus of 903
> migrations contains zero instances and there is no precedent to shelter behind.
>
> **Every index below is a plain `CREATE INDEX` under a 5-second `lock_timeout`.** That
> is what the codebase actually does and what CI actually accepts. The half of BE-65 that
> *is* enforceable — "name every constraint and index explicitly" — is honoured
> throughout. BE-65's first clause should be amended to record the drizzle-kit
> constraint; that is a `CLAUDE.md` edit outside this ticket's scope and is listed in §11.

> ### ⚠️ **The PostgreSQL floor is 15, not 18.**
>
> The brief stated "production is PG18; the chain uses PG18-only syntax, so PG17 fails."
> **That is wrong, and it matters, because it would send someone hunting for an
> unnecessarily exotic database.** The peer analysis at
> `docs/migration-static-verification-2026-09-21.md:200`–`227` established, and this
> document re-checked, that:
> - The newest syntax in the chain is `ON DELETE SET NULL (column_list)`, which requires
>   **PostgreSQL 15**. Roughly 100 migration files already use it; the earliest is
>   `migrations/0265_party_association_columns.sql`.
> - **No file in the repository declares a minimum PostgreSQL version.** `package.json`
>   has `engines.node` and no database field.
> - **CI's only PostgreSQL service is `pgvector/pgvector:pg16`**
>   (`.github/workflows/db-gates.yml:77, :409, :490`) and the full DB gate suite passes
>   against it. PG16 is therefore *proven* sufficient for the existing chain.
> - Production Aurora is 18.4 (`src/db/pool.config.ts:207`) — that is where the chain
>   *runs*, not what it *requires*.
>
> A grep for PG18-only syntax (`uuidv7()`, `NOT ENFORCED`, `… VIRTUAL`, `WITHOUT
> OVERLAPS`, `RETURNING OLD/NEW`) returns three files, all matching on the phrase
> "NOT ENFORCED" inside prose comments, none in executable SQL.
>
> **Nothing in this design raises the floor.** It adds no syntax newer than PG15.

### 7.1 `migrations/1143_ticket_bug_details.sql`

```sql
-- 1143: the canonical BUG work item gains its QA extension record.
--
-- Twelve of the thirteen columns below exist today on build.bugs and have no
-- counterpart on build.tickets. They move here rather than onto tickets because
-- they are meaningless on EPIC, STORY and TASK rows, and because tickets' index
-- layout is tuned byte by byte (see ticket-core.ts:119-128). BE-42 forbids the
-- JSONB alternative and BE-43 forbids the polymorphic one; a link table for one
-- relationship to one parent is what BE-43 prescribes instead.
--
-- Every column is nullable here. 1146 seals bug_number, qa_status and severity
-- once 1145 has filled them (BE-61). No CREATE TYPE: public.bug_severity and
-- public.bug_status already exist (0000_light_vance_astro.sql:182-183) and are
-- reused verbatim, so no rollback carries a DROP TYPE obligation.
--
-- No deleted_at. The row's lifecycle is its parent ticket's; two independent
-- soft-delete flags on a 1:1 pair diverge silently, which is the hazard BE-54
-- describes. Reads filter tickets.deleted_at on the join.

SET lock_timeout = '5s';
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "build"."ticket_bug_details" (
  "org_id"                 text    NOT NULL,
  "ticket_id"              integer NOT NULL,
  "project_id"             integer NOT NULL,
  "bug_number"             integer,
  "qa_status"              "public"."bug_status",
  "severity"               "public"."bug_severity",
  "steps_to_reproduce"     text,
  "expected_result"        text,
  "actual_result"          text,
  "environment"            text,
  "browser_device"         text,
  "reopen_count"           integer NOT NULL DEFAULT 0,
  "affected_release_id"    integer,
  "fixed_release_id"       integer,
  "qa_owner_membership_id" integer,
  "linked_test_case_id"    integer,
  "created_at"             timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"             timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "ticket_bug_details_pkey" PRIMARY KEY ("org_id", "ticket_id")
);
--> statement-breakpoint

ALTER TABLE "build"."ticket_bug_details"
  ADD CONSTRAINT "fk_ticket_bug_details_org"
  FOREIGN KEY ("org_id") REFERENCES "public"."organizations" ("id")
  ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."ticket_bug_details" VALIDATE CONSTRAINT "fk_ticket_bug_details_org";
--> statement-breakpoint

ALTER TABLE "build"."ticket_bug_details"
  ADD CONSTRAINT "fk_ticket_bug_details_org_ticket"
  FOREIGN KEY ("org_id", "ticket_id") REFERENCES "build"."tickets" ("org_id", "id")
  ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."ticket_bug_details" VALIDATE CONSTRAINT "fk_ticket_bug_details_org_ticket";
--> statement-breakpoint

ALTER TABLE "build"."ticket_bug_details"
  ADD CONSTRAINT "fk_ticket_bug_details_org_project"
  FOREIGN KEY ("org_id", "project_id") REFERENCES "build"."projects" ("org_id", "id")
  ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."ticket_bug_details" VALIDATE CONSTRAINT "fk_ticket_bug_details_org_project";
--> statement-breakpoint

ALTER TABLE "build"."ticket_bug_details"
  ADD CONSTRAINT "fk_ticket_bug_details_org_affected_release"
  FOREIGN KEY ("org_id", "affected_release_id") REFERENCES "build"."project_releases" ("org_id", "id")
  ON DELETE SET NULL ("affected_release_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."ticket_bug_details" VALIDATE CONSTRAINT "fk_ticket_bug_details_org_affected_release";
--> statement-breakpoint

ALTER TABLE "build"."ticket_bug_details"
  ADD CONSTRAINT "fk_ticket_bug_details_org_fixed_release"
  FOREIGN KEY ("org_id", "fixed_release_id") REFERENCES "build"."project_releases" ("org_id", "id")
  ON DELETE SET NULL ("fixed_release_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."ticket_bug_details" VALIDATE CONSTRAINT "fk_ticket_bug_details_org_fixed_release";
--> statement-breakpoint

ALTER TABLE "build"."ticket_bug_details"
  ADD CONSTRAINT "fk_ticket_bug_details_org_test_case"
  FOREIGN KEY ("org_id", "linked_test_case_id") REFERENCES "build"."test_cases" ("org_id", "id")
  ON DELETE SET NULL ("linked_test_case_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."ticket_bug_details" VALIDATE CONSTRAINT "fk_ticket_bug_details_org_test_case";
--> statement-breakpoint

ALTER TABLE "build"."ticket_bug_details"
  ADD CONSTRAINT "fk_ticket_bug_details_qa_owner_actor"
  FOREIGN KEY ("org_id", "qa_owner_membership_id") REFERENCES "public"."organization_members" ("org_id", "id")
  ON DELETE SET NULL ("qa_owner_membership_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."ticket_bug_details" VALIDATE CONSTRAINT "fk_ticket_bug_details_qa_owner_actor";
--> statement-breakpoint

-- Not CONCURRENTLY: db:migrate runs inside a transaction and
-- check:migration-discipline check 7 rejects it. lock_timeout bounds the wait.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_ticket_bug_details_project_bug_number"
  ON "build"."ticket_bug_details" ("project_id", "bug_number");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ticket_bug_details_org_project_qa_status"
  ON "build"."ticket_bug_details" ("org_id", "project_id", "qa_status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ticket_bug_details_org_project_severity"
  ON "build"."ticket_bug_details" ("org_id", "project_id", "severity");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ticket_bug_details_org_qa_owner_membership"
  ON "build"."ticket_bug_details" ("org_id", "qa_owner_membership_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ticket_bug_details_org_affected_release"
  ON "build"."ticket_bug_details" ("org_id", "affected_release_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ticket_bug_details_org_fixed_release"
  ON "build"."ticket_bug_details" ("org_id", "fixed_release_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ticket_bug_details_org_test_case"
  ON "build"."ticket_bug_details" ("org_id", "linked_test_case_id");
--> statement-breakpoint

ALTER TABLE "build"."ticket_bug_details" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "build"."ticket_bug_details";
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "build"."ticket_bug_details"
  USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "build"."ticket_bug_details" TO streamline_app;
```

**`migrations/rollback/1143_ticket_bug_details.down.sql`**

```sql
-- Rollback for 1143. DESTRUCTIVE.
--
-- Run BEFORE 1145 this drops an empty table and loses nothing. Run AFTER 1145 it
-- discards every migrated bug's QA payload -- steps to reproduce, environment,
-- severity, the original bug number. Roll back 1145 first; it is checked here.

SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
DECLARE
  populated bigint;
BEGIN
  SELECT count(*) INTO populated FROM "build"."ticket_bug_details";
  IF populated > 0 THEN
    RAISE EXCEPTION
      'rollback 1143 refused: ticket_bug_details holds % row(s). Run rollback/1145 first, which empties it, or drop this table knowingly by TRUNCATE-ing it yourself.',
      populated;
  END IF;
END $$;
--> statement-breakpoint

DROP TABLE IF EXISTS "build"."ticket_bug_details";
```

### 7.2 `migrations/1144_bug_ticket_migration_map.sql`

```sql
-- 1144: the durable ledger of what the 1145 backfill did.
--
-- Three jobs, none of which a column on bugs would do as well:
--   * It makes 1145 re-runnable and batchable. A bug with a map row is done;
--     the next batch is "the rows without one". A crash resumes, not restarts.
--   * It records the DISPOSITION -- created | adopted -- which the rollback
--     needs, because it must delete only tickets it created and must not touch
--     a pre-existing ticket that was merely retyped.
--   * prior_type is what 'adopted' overwrote on tickets.type. Without it the
--     rollback cannot restore a STORY that was retyped to BUG.
--
-- It is also, in BE-43 terms, the link table for one relationship. It survives
-- the retirement of build.bugs as the provenance record and is dropped only
-- with it.

SET lock_timeout = '5s';
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "build"."bug_ticket_migration_map" (
  "org_id"      text    NOT NULL,
  "bug_id"      integer NOT NULL,
  "ticket_id"   integer NOT NULL,
  "disposition" text    NOT NULL,
  "prior_type"  "public"."ticket_type",
  "created_at"  timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "bug_ticket_migration_map_pkey" PRIMARY KEY ("org_id", "bug_id"),
  CONSTRAINT "chk_bug_ticket_migration_map_disposition"
    CHECK ("disposition" IN ('created', 'adopted'))
);
--> statement-breakpoint

ALTER TABLE "build"."bug_ticket_migration_map"
  ADD CONSTRAINT "fk_bug_ticket_migration_map_org"
  FOREIGN KEY ("org_id") REFERENCES "public"."organizations" ("id")
  ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."bug_ticket_migration_map" VALIDATE CONSTRAINT "fk_bug_ticket_migration_map_org";
--> statement-breakpoint

ALTER TABLE "build"."bug_ticket_migration_map"
  ADD CONSTRAINT "fk_bug_ticket_migration_map_org_bug"
  FOREIGN KEY ("org_id", "bug_id") REFERENCES "build"."bugs" ("org_id", "id")
  ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."bug_ticket_migration_map" VALIDATE CONSTRAINT "fk_bug_ticket_migration_map_org_bug";
--> statement-breakpoint

ALTER TABLE "build"."bug_ticket_migration_map"
  ADD CONSTRAINT "fk_bug_ticket_migration_map_org_ticket"
  FOREIGN KEY ("org_id", "ticket_id") REFERENCES "build"."tickets" ("org_id", "id")
  ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."bug_ticket_migration_map" VALIDATE CONSTRAINT "fk_bug_ticket_migration_map_org_ticket";
--> statement-breakpoint

-- Partial-unique on the adopters only: at most one bug may adopt a given
-- ticket, because ticket_bug_details' primary key admits exactly one detail row
-- per ticket. 'created' rows are unconstrained -- each has its own new ticket.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_bug_ticket_migration_map_adopted_ticket"
  ON "build"."bug_ticket_migration_map" ("org_id", "ticket_id")
  WHERE "disposition" = 'adopted';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_bug_ticket_migration_map_org_ticket"
  ON "build"."bug_ticket_migration_map" ("org_id", "ticket_id");
--> statement-breakpoint

ALTER TABLE "build"."bug_ticket_migration_map" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "build"."bug_ticket_migration_map";
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "build"."bug_ticket_migration_map"
  USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "build"."bug_ticket_migration_map" TO streamline_app;
```

**`migrations/rollback/1144_bug_ticket_migration_map.down.sql`**

```sql
-- Rollback for 1144. DESTRUCTIVE: drops the provenance ledger.
--
-- Refuses while the ledger is non-empty, because rollback/1145 reads it to
-- decide which tickets it created. Dropping it first strands every migrated
-- ticket with no way to tell it apart from a hand-created one.

SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
DECLARE
  mapped bigint;
BEGIN
  SELECT count(*) INTO mapped FROM "build"."bug_ticket_migration_map";
  IF mapped > 0 THEN
    RAISE EXCEPTION
      'rollback 1144 refused: the map holds % row(s) and rollback/1145 needs it to identify the tickets it must delete. Run rollback/1145 first.',
      mapped;
  END IF;
END $$;
--> statement-breakpoint

DROP TABLE IF EXISTS "build"."bug_ticket_migration_map";
```

### 7.3 `migrations/1145_backfill_bug_tickets.sql`

```sql
-- 1145: move every build.bugs row onto a canonical BUG ticket.
--
-- Order matters and is: assert -> adopt -> retype -> create (batched, per
-- project) -> details -> relations. Adoption runs first so the create pass can
-- see, via the map, which bugs are already placed.
--
-- tickets.status is NOT written as a literal. fk_tickets_status binds it to that
-- project's own project_statuses.name (ticket-core.ts:95-99) and project
-- statuses are user-editable, so 'TODO' is a 23503 waiting for the first
-- project that renamed its board. bug_status is mapped to a state_group and the
-- group is resolved to the project's leftmost column of that kind, with the
-- project's leftmost column of ANY kind as the fallback.
--
-- The original bug_status is not discarded -- it is carried verbatim into
-- ticket_bug_details.qa_status, because five of the nine values have no project
-- status equivalent anywhere in the product.
--
-- Ticket numbers come from build.project_ticket_counters using the exact
-- statement the application uses (allocate-ticket-number.ts:14-26), so the
-- backfill and a concurrent create cannot disagree about what is next.
--
-- qa_owner_membership_id is COALESCEd against a live organization_members
-- lookup: bugs.service.ts writes qa_owner_id and never the membership pointer,
-- so every bug created after 0908 has a NULL there. This repairs it in transit.
--
-- BE-68: heavy DO block, so statement_timeout is lifted.

SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = '5s';
--> statement-breakpoint

-- ── Assertion: a project with no statuses cannot hold a ticket ───────────────
DO $$
DECLARE
  offenders text;
BEGIN
  SELECT string_agg(format('(%s, %s)', x.org_id, x.project_id), ', ')
    INTO offenders
  FROM (
    SELECT DISTINCT b.org_id, b.project_id
    FROM "build"."bugs" b
    WHERE NOT EXISTS (
      SELECT 1 FROM "build"."project_statuses" ps
      WHERE ps.org_id = b.org_id AND ps.project_id = b.project_id
    )
  ) x;

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      '1145 refused: these (org_id, project_id) pairs hold bugs but have zero project_statuses rows, so no value satisfies fk_tickets_status: %. Seed their statuses (DEFAULT_PROJECT_STATUSES) and re-run.',
      offenders;
  END IF;
END $$;
--> statement-breakpoint

-- ── Pass 1: adopt. Lowest bug_number claims a live, same-project linked ticket ─
INSERT INTO "build"."bug_ticket_migration_map" (org_id, bug_id, ticket_id, disposition, prior_type)
SELECT b.org_id, b.id, b.linked_ticket_id, 'adopted', t.type
FROM "build"."bugs" b
JOIN "build"."tickets" t
  ON t.org_id = b.org_id AND t.id = b.linked_ticket_id
WHERE b.deleted_at IS NULL
  AND t.deleted_at IS NULL
  AND t.project_id = b.project_id
  AND b.bug_number = (
    SELECT min(b2.bug_number)
    FROM "build"."bugs" b2
    WHERE b2.org_id = b.org_id
      AND b2.linked_ticket_id = b.linked_ticket_id
      AND b2.project_id = b.project_id
      AND b2.deleted_at IS NULL
  )
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- ── Pass 2: adopted tickets become BUG ───────────────────────────────────────
UPDATE "build"."tickets" t
SET type = 'BUG', updated_at = now()
FROM "build"."bug_ticket_migration_map" m
WHERE m.org_id = t.org_id
  AND m.ticket_id = t.id
  AND m.disposition = 'adopted'
  AND t.type <> 'BUG';
--> statement-breakpoint

-- ── Pass 3: create a new BUG ticket for every remaining bug ──────────────────
DO $$
DECLARE
  proj      record;
  total     bigint;
  start_num bigint;
  emitted   bigint;
  made      bigint;
  batch     constant integer := 500;
BEGIN
  FOR proj IN
    SELECT b.org_id, b.project_id, count(*)::bigint AS cnt
    FROM "build"."bugs" b
    LEFT JOIN "build"."bug_ticket_migration_map" m
      ON m.org_id = b.org_id AND m.bug_id = b.id
    WHERE m.bug_id IS NULL
    GROUP BY b.org_id, b.project_id
  LOOP
    total := proj.cnt;

    INSERT INTO "build"."project_ticket_counters" (org_id, project_id, next_ticket_number)
    SELECT proj.org_id, proj.project_id, COALESCE(MAX(ticket_number), 0) + total + 1
    FROM "build"."tickets"
    WHERE org_id = proj.org_id AND project_id = proj.project_id
    ON CONFLICT (org_id, project_id) DO UPDATE
      SET next_ticket_number = GREATEST(
            project_ticket_counters.next_ticket_number,
            EXCLUDED.next_ticket_number - total
          ) + total,
          updated_at = now()
    RETURNING next_ticket_number - total INTO start_num;

    emitted := 0;

    LOOP
      WITH pending AS (
        SELECT b.*,
               row_number() OVER (ORDER BY b.bug_number) - 1 AS offs
        FROM "build"."bugs" b
        LEFT JOIN "build"."bug_ticket_migration_map" m
          ON m.org_id = b.org_id AND m.bug_id = b.id
        WHERE m.bug_id IS NULL
          AND b.org_id = proj.org_id
          AND b.project_id = proj.project_id
        ORDER BY b.bug_number
        LIMIT batch
      ),
      resolved AS (
        SELECT p.*,
               COALESCE(
                 (SELECT ps.name FROM "build"."project_statuses" ps
                   WHERE ps.org_id = p.org_id
                     AND ps.project_id = p.project_id
                     AND ps.type = (CASE p.status
                       WHEN 'new'          THEN 'backlog'
                       WHEN 'triaged'      THEN 'unstarted'
                       WHEN 'assigned'     THEN 'unstarted'
                       WHEN 'in_progress'  THEN 'started'
                       WHEN 'fixed'        THEN 'started'
                       WHEN 'ready_for_qa' THEN 'started'
                       WHEN 'reopened'     THEN 'started'
                       WHEN 'verified'     THEN 'completed'
                       WHEN 'closed'       THEN 'completed'
                     END)::"public"."state_group"
                   ORDER BY ps."order", ps.id
                   LIMIT 1),
                 (SELECT ps.name FROM "build"."project_statuses" ps
                   WHERE ps.org_id = p.org_id AND ps.project_id = p.project_id
                   ORDER BY ps."order", ps.id
                   LIMIT 1)
               ) AS mapped_status
        FROM pending p
      ),
      ins AS (
        INSERT INTO "build"."tickets" (
          org_id, project_id, ticket_number, title, description, type, status,
          priority, assignee_membership_id, reporter_id, deleted_at,
          created_at, updated_at
        )
        SELECT r.org_id,
               r.project_id,
               start_num + emitted + r.offs,
               r.title,
               r.description,
               'BUG',
               r.mapped_status,
               upper(r.priority::text)::"public"."ticket_priority",
               r.assignee_membership_id,
               r.reporter_id,
               r.deleted_at,
               r.created_at,
               r.updated_at
        FROM resolved r
        RETURNING id, project_id, ticket_number
      )
      INSERT INTO "build"."bug_ticket_migration_map" (org_id, bug_id, ticket_id, disposition, prior_type)
      SELECT p.org_id, p.id, i.id, 'created', NULL
      FROM pending p
      JOIN ins i
        ON i.project_id = p.project_id
       AND i.ticket_number = start_num + emitted + p.offs;

      GET DIAGNOSTICS made = ROW_COUNT;
      EXIT WHEN made = 0;
      emitted := emitted + made;
    END LOOP;

    IF emitted <> total THEN
      RAISE EXCEPTION
        '1145 arithmetic failure on (%, %): reserved % number(s), emitted %.',
        proj.org_id, proj.project_id, total, emitted;
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint

-- ── Pass 4: the QA payload ───────────────────────────────────────────────────
INSERT INTO "build"."ticket_bug_details" (
  org_id, ticket_id, project_id, bug_number, qa_status, severity,
  steps_to_reproduce, expected_result, actual_result, environment, browser_device,
  reopen_count, affected_release_id, fixed_release_id, qa_owner_membership_id,
  linked_test_case_id, created_at, updated_at
)
SELECT m.org_id,
       m.ticket_id,
       b.project_id,
       b.bug_number,
       b.status,
       b.severity,
       b.steps_to_reproduce,
       b.expected_result,
       b.actual_result,
       b.environment,
       b.browser_device,
       b.reopen_count,
       b.affected_release_id,
       b.fixed_release_id,
       COALESCE(b.qa_owner_membership_id, om.id),
       b.linked_test_case_id,
       b.created_at,
       b.updated_at
FROM "build"."bug_ticket_migration_map" m
JOIN "build"."bugs" b
  ON b.org_id = m.org_id AND b.id = m.bug_id
LEFT JOIN "public"."organization_members" om
  ON om.org_id = b.org_id
 AND om.user_id = b.qa_owner_id
 AND om.status = 'ACTIVE'
ON CONFLICT ("org_id", "ticket_id") DO NOTHING;
--> statement-breakpoint

-- ── Pass 5: duplicate_of, for bugs that lost the adoption race ───────────────
INSERT INTO "build"."work_item_relations" (org_id, work_item_id, related_work_item_id, relation_type)
SELECT m.org_id, m.ticket_id, b.linked_ticket_id, 'duplicate_of'
FROM "build"."bug_ticket_migration_map" m
JOIN "build"."bugs" b   ON b.org_id = m.org_id AND b.id = m.bug_id
JOIN "build"."tickets" t ON t.org_id = b.org_id AND t.id = b.linked_ticket_id
WHERE m.disposition = 'created'
  AND b.linked_ticket_id IS NOT NULL
  AND b.deleted_at IS NULL
  AND t.deleted_at IS NULL
  AND t.project_id = b.project_id
  AND m.ticket_id <> b.linked_ticket_id
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- ── Pass 6: relates_to, for cross-project links ──────────────────────────────
INSERT INTO "build"."work_item_relations" (org_id, work_item_id, related_work_item_id, relation_type)
SELECT m.org_id, m.ticket_id, b.linked_ticket_id, 'relates_to'
FROM "build"."bug_ticket_migration_map" m
JOIN "build"."bugs" b   ON b.org_id = m.org_id AND b.id = m.bug_id
JOIN "build"."tickets" t ON t.org_id = b.org_id AND t.id = b.linked_ticket_id
WHERE m.disposition = 'created'
  AND b.linked_ticket_id IS NOT NULL
  AND t.project_id <> b.project_id
  AND m.ticket_id <> b.linked_ticket_id
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- ── Reconciliation: every bug placed exactly once ────────────────────────────
DO $$
DECLARE
  unplaced bigint;
  undetailed bigint;
BEGIN
  SELECT count(*) INTO unplaced
  FROM "build"."bugs" b
  LEFT JOIN "build"."bug_ticket_migration_map" m
    ON m.org_id = b.org_id AND m.bug_id = b.id
  WHERE m.bug_id IS NULL;

  IF unplaced > 0 THEN
    RAISE EXCEPTION '1145 incomplete: % bug row(s) have no map entry.', unplaced;
  END IF;

  SELECT count(*) INTO undetailed
  FROM "build"."bug_ticket_migration_map" m
  LEFT JOIN "build"."ticket_bug_details" d
    ON d.org_id = m.org_id AND d.ticket_id = m.ticket_id
  WHERE d.ticket_id IS NULL;

  IF undetailed > 0 THEN
    RAISE EXCEPTION '1145 incomplete: % mapped bug(s) have no ticket_bug_details row.', undetailed;
  END IF;
END $$;
--> statement-breakpoint

ANALYZE "build"."tickets";
--> statement-breakpoint
ANALYZE "build"."ticket_bug_details";
```

**`migrations/rollback/1145_backfill_bug_tickets.down.sql`**

```sql
-- Rollback for 1145. DESTRUCTIVE, and in a way that is easy to underestimate.
--
-- Between the forward run and this one, people will have used the migrated
-- tickets: comments, watchers, activity, checklists, time entries, labels,
-- release associations, sprint and cycle placement. Deleting a created ticket
-- cascades all of it away. NONE of that is recoverable from build.bugs, which
-- never held it. Read that sentence twice before running this.
--
-- What it does NOT do, deliberately:
--   * It does not rewind build.project_ticket_counters. Rewinding could reissue
--     a ticket_number that a concurrent create has already taken. Gaps in
--     ticket_number are harmless; duplicates are a 23505 on every subsequent
--     create in that project.
--   * It does not restore build.bugs. build.bugs was never modified; it is
--     still the source of truth at this point in the sequence. That is the
--     whole reason the retirement migration is deferred (see 7.7).
--
-- One condition makes the delete impossible rather than merely destructive: a
-- created ticket may have become another ticket's epic_id or parent_ticket_id,
-- and fk_tickets_org_epic / fk_tickets_org_parent (ticket-core.ts:88-89) carry
-- no ON DELETE action, so the delete raises 23503. That is checked FIRST, with
-- the offending ids named, so the operator fixes it deliberately instead of
-- reading a bare constraint violation.

SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
DECLARE
  blocked text;
BEGIN
  SELECT string_agg(DISTINCT m.ticket_id::text, ', ')
    INTO blocked
  FROM "build"."bug_ticket_migration_map" m
  JOIN "build"."tickets" child
    ON child.org_id = m.org_id
   AND (child.epic_id = m.ticket_id OR child.parent_ticket_id = m.ticket_id)
  WHERE m.disposition = 'created';

  IF blocked IS NOT NULL THEN
    RAISE EXCEPTION
      'rollback 1145 refused: migrated ticket(s) % are the epic or parent of another ticket, and fk_tickets_org_epic / fk_tickets_org_parent have no ON DELETE action. Re-parent those children, then re-run.',
      blocked;
  END IF;
END $$;
--> statement-breakpoint

DELETE FROM "build"."work_item_relations" r
USING "build"."bug_ticket_migration_map" m
WHERE r.org_id = m.org_id
  AND r.work_item_id = m.ticket_id
  AND m.disposition = 'created'
  AND r.relation_type IN ('duplicate_of', 'relates_to');
--> statement-breakpoint

DELETE FROM "build"."ticket_bug_details" d
USING "build"."bug_ticket_migration_map" m
WHERE d.org_id = m.org_id AND d.ticket_id = m.ticket_id;
--> statement-breakpoint

UPDATE "build"."tickets" t
SET type = m.prior_type, updated_at = now()
FROM "build"."bug_ticket_migration_map" m
WHERE m.org_id = t.org_id
  AND m.ticket_id = t.id
  AND m.disposition = 'adopted'
  AND m.prior_type IS NOT NULL;
--> statement-breakpoint

DELETE FROM "build"."tickets" t
USING "build"."bug_ticket_migration_map" m
WHERE t.org_id = m.org_id
  AND t.id = m.ticket_id
  AND m.disposition = 'created';
--> statement-breakpoint

DELETE FROM "build"."bug_ticket_migration_map";
--> statement-breakpoint

ANALYZE "build"."tickets";
```

### 7.4 `migrations/1146_ticket_bug_details_not_null.sql`

```sql
-- 1146: seal the three columns 1145 guarantees are populated.
--
-- Separate from 1143 because BE-61 requires nullable -> backfill -> NOT NULL,
-- and separate from 1145 because BE-61 also requires one purpose per migration.
-- BE-63 shape throughout: CHECK (col IS NOT NULL) NOT VALID -> VALIDATE ->
-- SET NOT NULL -> DROP CONSTRAINT. The SET NOT NULL then never rewrites the
-- table, because the validated CHECK already proves the predicate.
--
-- This migration correctly REFUSES if 1145 did not run, or ran partially. That
-- is the point of it.

SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE "build"."ticket_bug_details"
  ADD CONSTRAINT "chk_ticket_bug_details_bug_number_nn"
  CHECK ("bug_number" IS NOT NULL) NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."ticket_bug_details" VALIDATE CONSTRAINT "chk_ticket_bug_details_bug_number_nn";
--> statement-breakpoint
ALTER TABLE "build"."ticket_bug_details" ALTER COLUMN "bug_number" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "build"."ticket_bug_details" DROP CONSTRAINT "chk_ticket_bug_details_bug_number_nn";
--> statement-breakpoint

ALTER TABLE "build"."ticket_bug_details"
  ADD CONSTRAINT "chk_ticket_bug_details_qa_status_nn"
  CHECK ("qa_status" IS NOT NULL) NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."ticket_bug_details" VALIDATE CONSTRAINT "chk_ticket_bug_details_qa_status_nn";
--> statement-breakpoint
ALTER TABLE "build"."ticket_bug_details" ALTER COLUMN "qa_status" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "build"."ticket_bug_details" ALTER COLUMN "qa_status" SET DEFAULT 'new';
--> statement-breakpoint
ALTER TABLE "build"."ticket_bug_details" DROP CONSTRAINT "chk_ticket_bug_details_qa_status_nn";
--> statement-breakpoint

ALTER TABLE "build"."ticket_bug_details"
  ADD CONSTRAINT "chk_ticket_bug_details_severity_nn"
  CHECK ("severity" IS NOT NULL) NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."ticket_bug_details" VALIDATE CONSTRAINT "chk_ticket_bug_details_severity_nn";
--> statement-breakpoint
ALTER TABLE "build"."ticket_bug_details" ALTER COLUMN "severity" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "build"."ticket_bug_details" ALTER COLUMN "severity" SET DEFAULT 'major';
--> statement-breakpoint
ALTER TABLE "build"."ticket_bug_details" DROP CONSTRAINT "chk_ticket_bug_details_severity_nn";
```

**`migrations/rollback/1146_ticket_bug_details_not_null.down.sql`**

```sql
-- Rollback for 1146. Relaxes three NOT NULLs and removes two defaults.
-- Catalog-only in both directions: DROP NOT NULL never rewrites the table.
-- Loses no data. Its only effect is to re-admit rows that 1145 cannot produce.

SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE "build"."ticket_bug_details" ALTER COLUMN "severity" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "build"."ticket_bug_details" ALTER COLUMN "severity" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "build"."ticket_bug_details" ALTER COLUMN "qa_status" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "build"."ticket_bug_details" ALTER COLUMN "qa_status" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "build"."ticket_bug_details" ALTER COLUMN "bug_number" DROP NOT NULL;
```

### 7.5 `migrations/1147_test_run_results_linked_ticket.sql`

```sql
-- 1147: test_run_results gains a pointer to the canonical ticket.
--
-- Added nullable and left nullable permanently -- a result that has not raised
-- a bug has no ticket, which is the common case. linked_bug_id is NOT touched
-- here; both pointers coexist for one release so a rollback of the application
-- does not strand the data. See 7.7.

SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE "build"."test_run_results" ADD COLUMN IF NOT EXISTS "linked_ticket_id" integer;
--> statement-breakpoint

ALTER TABLE "build"."test_run_results"
  ADD CONSTRAINT "fk_test_run_results_org_ticket"
  FOREIGN KEY ("org_id", "linked_ticket_id") REFERENCES "build"."tickets" ("org_id", "id")
  ON DELETE SET NULL ("linked_ticket_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."test_run_results" VALIDATE CONSTRAINT "fk_test_run_results_org_ticket";
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_test_run_results_org_linked_ticket"
  ON "build"."test_run_results" ("org_id", "linked_ticket_id");
```

**`migrations/rollback/1147_test_run_results_linked_ticket.down.sql`**

```sql
-- Rollback for 1147. DESTRUCTIVE: drops linked_ticket_id and every value in it.
--
-- Safe only while linked_bug_id is still present and still populated, which is
-- the invariant 7.7 protects by deferring the retirement migration. If
-- linked_bug_id has already been dropped, this rollback severs the only link
-- between a failed test result and the bug it raised, with no way back.

SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build'
      AND table_name = 'test_run_results'
      AND column_name = 'linked_bug_id'
  ) THEN
    RAISE EXCEPTION
      'rollback 1147 refused: test_run_results.linked_bug_id has already been dropped, so linked_ticket_id is the only surviving result-to-bug link. Restore linked_bug_id first.';
  END IF;
END $$;
--> statement-breakpoint

DROP INDEX IF EXISTS "build"."idx_test_run_results_org_linked_ticket";
--> statement-breakpoint
ALTER TABLE "build"."test_run_results" DROP CONSTRAINT IF EXISTS "fk_test_run_results_org_ticket";
--> statement-breakpoint
ALTER TABLE "build"."test_run_results" DROP COLUMN IF EXISTS "linked_ticket_id";
```

### 7.6 `migrations/1148_backfill_test_run_results_linked_ticket.sql`

```sql
-- 1148: repoint every result that references a bug at that bug's ticket.
--
-- Total by construction: 1145's reconciliation block proves every bug row has
-- exactly one map entry, so every non-NULL linked_bug_id resolves. The final
-- assertion re-proves it here rather than assuming it, because 1145 and 1148
-- may be separated by a rollback.
--
-- Batched by primary key so a large table does not hold one long write lock.

SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
DECLARE
  moved bigint;
BEGIN
  LOOP
    WITH batch AS (
      SELECT r.id, m.ticket_id
      FROM "build"."test_run_results" r
      JOIN "build"."bug_ticket_migration_map" m
        ON m.org_id = r.org_id AND m.bug_id = r.linked_bug_id
      WHERE r.linked_bug_id IS NOT NULL
        AND r.linked_ticket_id IS NULL
      LIMIT 1000
    )
    UPDATE "build"."test_run_results" r
    SET linked_ticket_id = batch.ticket_id, updated_at = now()
    FROM batch
    WHERE r.id = batch.id;

    GET DIAGNOSTICS moved = ROW_COUNT;
    EXIT WHEN moved = 0;
  END LOOP;
END $$;
--> statement-breakpoint

DO $$
DECLARE
  stranded bigint;
BEGIN
  SELECT count(*) INTO stranded
  FROM "build"."test_run_results"
  WHERE linked_bug_id IS NOT NULL AND linked_ticket_id IS NULL;

  IF stranded > 0 THEN
    RAISE EXCEPTION
      '1148 incomplete: % test_run_results row(s) reference a bug with no map entry. 1145 did not finish.',
      stranded;
  END IF;
END $$;
--> statement-breakpoint

ANALYZE "build"."test_run_results";
```

**`migrations/rollback/1148_backfill_test_run_results_linked_ticket.down.sql`**

```sql
-- Rollback for 1148. DESTRUCTIVE only in appearance.
--
-- It nulls linked_ticket_id wherever linked_bug_id still carries the same fact,
-- so nothing is actually lost. It deliberately leaves alone any row where
-- linked_bug_id is NULL and linked_ticket_id is not -- such a row was written by
-- the NEW application code against a ticket that never was a bug, and 1148 did
-- not create it.

SET lock_timeout = '5s';
--> statement-breakpoint

UPDATE "build"."test_run_results"
SET linked_ticket_id = NULL, updated_at = now()
WHERE linked_ticket_id IS NOT NULL
  AND linked_bug_id IS NOT NULL;
```

### 7.7 The retirement migration is deferred, and deliberately not authored

Dropping `build.bugs` and `test_run_results.linked_bug_id` is the obvious next step and
**must not ship in the same release**. Three reasons, each independently sufficient:

1. **`check:drop-column-safety` will fail.** It cross-references dropped columns against
   the Drizzle schema (`check-drop-column-safety.mjs`, reported clean over "903 migration
   file(s), 134 dropped column(s), 413 schema file(s)"). While `src/db/schema/build/qa.ts:138`
   still declares `bugs`, a migration dropping it is a gate failure.
2. **There is no rollback for it.** BE-71 requires one. Restoring a dropped table from a
   ledger is not a rollback, it is a restore. The only honest `.down.sql` for
   `DROP TABLE build.bugs` is one that refuses.
3. **The application must be proven to run on `tickets` first.** One production release
   where `bugs` is written-to-but-unread, then one where it is neither, then the drop.

**Preconditions for authoring it**, all of which are checkable:

- `bugs` has not been written for one full release (the `bug.created` / `bug.status_changed`
  audit actions at `bugs.service.ts:103` and `:173` stop appearing).
- `grep -rn "bugs" src/ --include=*.ts` returns only `bug_ticket_migration_map` references.
- `src/db/schema/build/qa.ts` no longer exports `bugs`.
- `test_run_results.linked_bug_id` is read by nothing (`qa-response.schemas.ts:93` removed).
- `build.artifacts.ts:114` and `:195` are re-pointed at `ticket_bug_details` — the catalog
  is a hand-maintained ruling file, not a generated registry, so it is edited, not regenerated.

`bug_ticket_migration_map` outlives `bugs` as the provenance record — "ticket 207 was bug
14" — and is dropped only when the historical mapping stops mattering.

---

## 8. Decision 6 — the controller and service rewrite

### 8.1 Shape

`/build/:projectId/bugs` becomes **a filtered view of the canonical explorer**, not a
second explorer. `BugsService` stops owning a table and becomes a projection over
`tickets ⋈ ticket_bug_details` with `tickets.type = 'BUG'` pinned.

| Route | Before | After |
|---|---|---|
| `GET /build/:p/bugs` | `bugs.service.ts:20` — `SELECT * FROM bugs`, `ORDER BY bug_number`, `LIMIT 100`, no cursor | delegates to the tickets read path with `type = ['BUG']` forced, joined to `ticket_bug_details`; **gains the keyset cursor the tickets path already has** (`projects-work-query.cursor.ts`) |
| `GET /build/:p/bugs/:id` | `:42` | ticket-by-id + detail row |
| `POST /build/:p/bugs` | `:56` — `MAX(bug_number)+1` under advisory lock | `allocateTicketNumbers` + `INSERT tickets` + `INSERT ticket_bug_details`, one `db.transaction` (BE-48) |
| `PATCH /build/:p/bugs/:id` | `:113` | splits the payload across both tables in one transaction; **adds the `qa_status` transition guard that never existed** (§3.3) |
| `DELETE /build/:p/bugs/:id` | `:183` — sets `bugs.deleted_at` | sets `tickets.deleted_at`; the detail row follows by join, per §2 |

Route paths, permission keys (`build:bugs:view|create|update|delete`,
`src/modules/rbac/permissions/build.ts:56`–`77`) and the `@RequireModule("build")` gate
(`bugs.controller.ts:41`) are all **unchanged**. No RBAC migration, no frontend permission
churn. That is deliberate: it keeps the blast radius inside the service layer.

### 8.2 The `bug_number` allocation loses its advisory lock, and that is an improvement

`bugs.service.ts:59` takes `pg_advisory_xact_lock(projectId)` — note the argument is
`projectId` alone, **not** hashed with `orgId`, so two organizations' projects with the
same integer id serialize against each other. `allocateTicketNumbers` needs no advisory
lock at all: `ON CONFLICT … DO UPDATE … RETURNING` is atomic under any isolation level.
`ticket_bug_details.bug_number` is populated from the same reserved block, so the two
numbers stay in step without a second allocator.

### 8.3 `test-runs.service.ts` — the one behaviour change QA will notice

`createBugFromResult` (`test-runs.service.ts:384`–`417`) currently inserts a `bugs` row and
sets `testRunResults.linkedBugId` (`:415`). It becomes: allocate a ticket number, insert a
`BUG` ticket, insert the detail row carrying the generated `stepsToReproduce`
(`:379`–`383`, unchanged), and set `linked_ticket_id`. `linkedBugId` continues to be set
during the soak release, then stops.

The status it writes changes from `'new'` to the project's resolved `backlog` status —
the same §3.1 lookup — and `qa_status` keeps `'new'`.

### 8.4 What the QA surfaces need — two files

`features/build/qa/` is otherwise untouched (§1.6).

- `features/build/qa/runs/result-row.tsx:101`–`148`: `result.linkedBugId` becomes
  `result.linkedTicketId`; the `/build/{projectId}/bugs` deep link at `:103` becomes a
  ticket link. The `canCreateBug` permission (`run-execution-page.tsx:108`) stays
  `build:bugs:create`.
- `hooks/api/build/qa.ts`: `useCreateBugFromResult`'s response contract widens.

`features/build/bugs/` (4 files) is rewritten against the new contract.
`features/build/bugs/bug-schema.ts` keeps its `severity` and `status` enums verbatim —
they are still the QA vocabulary, now `severity` and `qa_status` on the detail row.

### 8.5 Contract

`bugRowSchema` (`qa-response.schemas.ts:108`–`136`) is the wire shape today and every
field in it survives except `qaOwnerId` (§1.5a) and `orgId`. Two fields change meaning and
**must** be renamed rather than silently repurposed, or the frontend decodes garbage:

- `id` — was `bugs.id`, becomes `tickets.id`.
- `status` — was `bug_status`, becomes the project status string. The QA value moves to a
  new `qaStatus` field.

`bugNumber` keeps its name and its meaning (§5.2); `ticketNumber` is added beside it.
Per the house hazard around `z.string()` over a `pgEnum`, `qaStatus` and `severity` stay
`z.enum(...)` with the exact nine and five members.

---

## 9. Drizzle schema changes

- `src/db/schema/build/qa.ts` — add `ticketBugDetails` and `bugTicketMigrationMap`; leave
  `bugs` declared until §7.7. Add `linkedTicketId` to `testRunResults`.
- `src/db/schema/build/relations.ts` — `tickets ⇄ ticketBugDetails` as `one`/`one`.
- **`db:generate` must not be run.** BE-57; `check:db-generate-guard` blocks it
  ("903 journal entries, latest snapshot 0464, real drift 438"). All six files are
  hand-authored, which is what the rule requires anyway.

---

## 10. What is verifiable without a database, and what is not

### 10.1 Verified in this worktree, now

| Check | Result |
|---|---|
| `pnpm typecheck` | **exit 0** — the stated baseline holds |
| `pnpm jest src/modules/build/qa --silent` | **6 suites, 77 tests, all passed** — nothing was broken; no code was changed |

Every factual claim in §1 was read at the cited line.

### 10.2 The twelve SQL files in §7 were run through the authoring gates — and passed

This is not a forecast. The twelve fenced SQL blocks in §7 were extracted from this
document verbatim, written into a **throwaway copy** of `migrations/` outside the
worktree (the repo's own `migrations/` was not touched — this document is the only file
this ticket produces), given the six journal entries from §7's table, and put through the
real gates. Both refused to report a vacuous pass: the discipline gate's own floor check
rejected a 6-file directory before the full tree was assembled.

```
$ node src/scripts/check-migration-discipline.mjs --migrations=<temp>/migrations
  SQL files found: 909
  Baselines: lock_timeout=155 fk-not-valid=44 set-not-null=21 validate-order=2
             do-breakpoint=0 no-journal=0 concurrently=0
check:migration-discipline PASSED
  909 SQL files checked, 0 new violations
exit 0

$ node src/scripts/check-migration-rollback.mjs --migrations=<temp>/migrations
check:migration-rollback PASSED
  909 migrations scanned
  All rollback type-name checks passed
exit 0

$ node src/scripts/check-drop-column-safety.mjs
  OK — no dropped column is still declared in the Drizzle schema
exit 0
```

909 = the 903 existing files plus these 6. **Zero new violations, and every baseline count
unchanged** — so nothing here was admitted by being grandfathered. Concretely this proves,
for all six files: `SET lock_timeout` present (check 1, BE-64); every
`ADD CONSTRAINT … FOREIGN KEY` carries `NOT VALID` (check 2, BE-62); every `SET NOT NULL`
is preceded by a validated `CHECK … NOT VALID` (check 3, BE-63); no `VALIDATE CONSTRAINT`
precedes its backfill (check 4); no `--> statement-breakpoint` inside a `DO $$` block
(check 5); every file is journalled (check 6, BE-58); no `CONCURRENTLY` (check 7 — see the
BE-65 box in §7.0); `idx` unique and no duplicate numeric prefix (check 8, BE-59); and a
`.down.sql` exists for all six with no `CREATE TYPE`/`DROP TYPE` mismatch (BE-71).

Still static, and the gates say so themselves: "This gate never executes a rollback",
"Not covered: applied-watermark skipping (needs the DB)".

The remaining no-database gates — `check:migration-immutability`, `check:watermark-free`,
`check:db-generate-guard`, the **declaration half** of `check:set-null-column-lists` —
are unaffected by this change set (it appends only; it edits no sealed file and drops no
column) and were confirmed clean at head by
`docs/migration-static-verification-2026-09-21.md:60`–`110`.

### 10.3 NOT verifiable without a database — state plainly

1. **Whether the SQL runs at all.** Syntax, `plpgsql` scoping, whether `RETURNING … INTO`
   inside the `ON CONFLICT` form behaves as written, whether the `pending`/`ins` CTE join
   resolves. Reading is not execution.
2. **§3's status resolution against real `project_statuses` rows.** The `COALESCE` fallback
   is untested against an org that renamed its board.
3. **The counter reservation under concurrency.** Whether a migration running beside live
   `POST /tickets` traffic really cannot collide.
4. **RLS on both new tables.** BE-72 names `db:verify-rls` as the authority and it cannot
   run. The policy is written in the shape of `1137:96`–`107`, which is precedent, not proof.
5. **The `ON DELETE SET NULL` column lists.** They live only in
   `pg_constraint.confdelsetcols`; nothing static can see them. Four of the constraints in
   1143 and one in 1147 use the form. This is the same `INCONCLUSIVE — 286 constraint(s)
   are UNVERIFIED` that `check:set-null-column-lists` already reports.
6. **BE-66 — replay from cold.** `check:migration-chain` and `migration:proof` are the
   only things that can say the chain reaches head. Both are banned here
   (`check:migration-chain` carries `--env-file-if-exists=.env`, which points at production).
7. **Batch sizing.** 500 and 1000 are guesses. Nobody knows how many `bugs` rows exist in
   production; **no row count appears anywhere in this repository**, so the numbers are
   un-tuned rather than wrong.
8. **Whether `bugs` actually has an RLS policy today** (§1.7) — inferred, not verified.
9. **OpenAPI regeneration.** `openapi:generate` is banned by the operating constraints for
   this session, so §8.5's contract change is designed but not emitted.

### 10.4 The exact blocking dependency

> **One empty, non-production PostgreSQL **15 or newer**, reachable as `DATABASE_URL` and
> as `SET_NULL_GATE_DATABASE_URL`.**

- **PG15 is the floor**, not PG18 — see the boxed correction in §7.0. `pgvector/pgvector:pg16`
  is already proven sufficient for the whole 903-migration chain by
  `.github/workflows/db-gates.yml:77`.
- It must be **empty**, so BE-66's cold replay is a real proof and not a branch apply.
- It must be **non-production**. `backend/.env` points at Aurora, its credentials are
  rejected (`28P01`), and the production ledger is near-empty — a replay there would
  attempt roughly 1,105 migrations against the live database.
- The cheapest unblock that exists today is **running `.github/workflows/db-gates.yml`**,
  which already stands up its own PG16 service. That closes §10.3 items 1, 2, 4, 5 and 6
  with no new infrastructure.

Nothing else blocks this work. Not the frontend, not RBAC, not the OpenAPI contract.

---

## 11. The `SUBTASK` loose thread — verdict

**`normalizeTicketType` does fold `SUBTASK` to `TASK` before the write. There is no live
write defect.**

`src/modules/build/core/tickets-helpers.ts:5`–`9`:

```ts
export function normalizeTicketType(type: string): TicketType {
  const upper = type.toUpperCase();
  const mapped = upper === "FEATURE" ? "STORY" : upper;
  return ticketTypeEnum.enumValues.find((v) => v === mapped) ?? "TASK";
}
```

`"SUBTASK"` is not in `ticketTypeEnum.enumValues` (`enums.ts:17`), `find` returns
`undefined`, and `?? "TASK"` catches it. Every write path that accepts a caller-supplied
type routes through it: create (`projects-tickets-create.service.ts:131`), update
(`projects-tickets-update.service.ts:143` and `:381`), create-from-feedback (`:275`), and
templates via its own identical copy (`projects-templates.service.ts:30`–`35`, same
`?? "TASK"` fallback). `entity/build-entity-ticket-create.ts:13` narrows to `["TASK","BUG"]`
before it ever gets there.

**But it is not clean, and three things about it should be recorded.**

**(a) The read path survives only by an undocumented `::text` cast.** The filter schemas
at `ticket.schemas.ts:62` and `:108` land at `projects-tickets-read.service.ts:264` and
`projects-work-query.service.ts:217`, both of which render:

```ts
sql`${tickets.type}::text = ANY(ARRAY[${sql.join(type.map((t) => sql`${t}`), sql`, `)}])`
```

The `::text` makes `?type=SUBTASK` valid SQL that matches zero rows. **The two immediately
adjacent branches do not do this** — `status` at `:256` and `priority` at `:259` both use
`inArray(...)`. If anyone "tidies" the `type` branch into `inArray(tickets.type, type)` for
consistency, `SUBTASK` binds to the `ticket_type` enum, PostgreSQL raises `22P02`
(`invalid input value for enum ticket_type: "SUBTASK"`) and every request carrying that
filter becomes a 500. **The cast is load-bearing and nothing says so** — there is no test
pinning it and no comment.

**(b) The published contract lies.** `createTicketSchema` (`ticket.schemas.ts:158`)
declares `z.enum(["TASK","BUG","STORY","EPIC","SUBTASK"])`, so `SUBTASK` appears in the
OpenAPI enum for `POST /build/:projectId/tickets`. A client that reads the contract, sends
`SUBTASK`, and gets `201` receives a ticket typed `TASK`. **Silent downgrade, no warning,
no 400.** Same for the AI surfaces: `src/modules/ai/core/dto/confirm-action-payloads.schemas.ts:12`
and `src/modules/ai/core/tools/projects-copilot-tools.ts:119` — the latter is a *tool
description handed to a model*, so the model is being told a type exists that does not.

**(c) The product does not model subtasks as a type.** It models them as
`tickets.parent_ticket_id` (`ticket-core.ts:51`), which is how
`projects-ticket-subresources-cross-project-binding.spec.ts:100`–`101` constructs one.
`SUBTASK` is vestigial.

**Recommended fix (small, and independent of this consolidation):** delete the `"SUBTASK"`
literal from all six lists — `ticket.schemas.ts:62`, `:63`, `:108`, `:109`, `:158`,
`confirm-action-payloads.schemas.ts:12`, `projects-copilot-tools.ts:119` — and add a spec
that pins the `::text` cast at `projects-tickets-read.service.ts:264` and
`projects-work-query.service.ts:217` by asserting a non-enum type filter returns empty
rather than throwing. That converts (a) from a latent 500 into a caught refactor.

**Severity: not a defect today; a published-contract falsehood and a latent 500 one
idiomatic refactor away.** Reported prominently as asked, and correctly scoped as
"not currently broken" rather than inflated.

---

## 12. Effort

Assumes a database exists. Without one, everything below is blocked at step 2.

| Step | Days | Notes |
|---|---|---|
| Author the six `.sql` + six `.down.sql` + journal entries | 0.5 | the SQL above; mostly transcription |
| Prove on a clean PG15+: cold replay, both directions, fixture data | **1.0** | **blocked** — this is where the design meets reality |
| Drizzle schema + relations (§9) | 0.5 | |
| Service and controller rewrite (§8.1–8.3) | 1.5 | the transition guard (§3.3) is new work, not a port |
| Response contract + OpenAPI regeneration (§8.5) | 0.5 | |
| Frontend: `features/build/bugs/` rewrite + 2 files in `qa/runs/` (§8.4) | 1.5 | smaller than feared — §1.6 |
| Specs: backfill dispositions, status resolution, renumbering, transitions | 1.0 | |
| **Subtotal to cutover** | **6.5** | |
| One production release of soak | — | calendar, not effort |
| Retirement migration + catalog re-point (§7.7) | 0.5 | after soak |

**≈ 7 engineer-days plus one release of soak.** The `SUBTASK` fix in §11 is ~0.5 days and
is independent — it should not wait for this.

---

## 13. Open items this design deliberately does not close

1. **`bug_status` has no `wont_fix` / `not_a_bug`**, so `state_group = 'cancelled'` is
   unreachable (§3.2). Adding them is a follow-up, not a backfill concern.
2. **BE-65's first clause contradicts `check:migration-discipline` check 7** (§7.0).
   `CLAUDE.md:90` should record the drizzle-kit transaction-wrapper constraint. Editing
   `CLAUDE.md` is outside this ticket.
3. **No PostgreSQL floor is declared anywhere** (§7.0, and
   `docs/migration-static-verification-2026-09-21.md:202`–`205`). A `README` prerequisite
   line and a boot assertion on `server_version_num >= 150000` would cost minutes.
4. **`bugs.service.ts:33`'s leading-wildcard `ILIKE`** (BE-49) is retired by the rewrite
   rather than fixed in place (§1.5b).
5. **Nobody knows how many `bugs` rows exist.** The batch sizes in 1145 and 1148 are
   un-tuned. First run on real data should be timed.
