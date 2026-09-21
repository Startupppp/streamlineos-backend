# Sprint / Cycle consolidation — migration and backfill design

Backlog P0 #6. Design only. Implementation is blocked; the blocker is named in §10.

Every claim below carries a `file:line`. Paths are relative to the backend repo root
unless prefixed `frontend/`, which is `D:/projects/personal/Streamlineos/frontend`.
Anything not verifiable from source without a database is marked **UNVERIFIED**.

---

## 0. Corrections to the brief

These were found while verifying the premises. Each is load-bearing for the design.

| # | Brief said | Source says |
|---|---|---|
| 1 | `sprints` has the events surface | `build_events.sprint_scope_events` has **exactly one writer in the entire repository**, and it is the one-shot backfill inside `migrations/0156_sprint_scope_events.sql:105-135`. No application code has ever inserted a row — the only `.from(sprintScopeEvents)` is a *read* at `src/modules/build/core/projects-reports.service.ts:103`. The "events surface" is a frozen snapshot, not a live surface. |
| 2 | Tickets carry both — implying one extra FK | There are **four** tables holding `sprint_id`, not one. `build.tickets` (`src/db/schema/build/ticket-core.ts:40,87`), `build.project_meetings` (`src/db/schema/build/meetings.ts:39,46`), `build.test_runs` (`src/db/schema/build/qa.ts:78,95,97`), `build_events.sprint_scope_events` (`src/db/schema/build/sprint-events.ts:22,35`). |
| 3 | `1141` and `1142` exist and are unapplied, so account for them | Confirmed (`migrations/meta/_journal.json` entries idx 1029/1030). But **1138 and 1139 never existed** — the journal jumps 1137 → 1140. Next free tag is **1143**, next free `idx` is **1031**, next free `when` is **1803000010430**. |
| 4 | Indexes `CONCURRENTLY` on large tables (BE-65) | The house has already ruled against it for this class of change: `migrations/1134_qa_keyset_cursor_indexes.sql:17-18` — *"CREATE INDEX is not CONCURRENTLY here because the runner wraps each migration in a transaction; lock_timeout is the fence, matching 1133."* The runner **does** support it (`src/scripts/run-pending-migrations.mjs:78-95` detects `CREATE (UNIQUE )?INDEX CONCURRENTLY` and runs the whole file **untransacted**), but that makes the file non-atomic. See §3.1 for the rule this design follows. |
| 5 | Baseline: 17 suites / 151 tests | Measured on this worktree: **18 suites / 157 tests, exit 0** (`pnpm jest src/modules/build/execution --silent`). |
| 6 | "a non-production PostgreSQL 15+ … PG17 will fail" | Self-contradictory. The real floor is **PG18**, for the reason given in §10. |
| 7 | `cycles` is the newer, cleaner shape | True of the columns, but `cycles.deleteCycle` is a **hard** delete (`src/modules/build/execution/cycles.service.ts:138`) while sprints soft-delete (`sprints.service.ts:171`). `cycles` has no `deleted_at` at all (`src/db/schema/build/core.ts:154-183`). The survivor must *gain* soft delete, not inherit it. |
| 8 | ~40 frontend files reference `sprintId`/`useSprints` | **164** frontend files contain `sprint` (120 excluding tests; 63 contain the literal `sprintId`). See §7.0. |
| 9 | the board URL state reads both `?cycle=` and `?sprint=` at `use-board-url-state.ts:75` | Those reads are at **`:66-67`**, and there are **three** params, not two: `?cycle=` (multi), `?sprint=` (board, single), `?sprintId=` (every filter-bar surface, single). `:70-78` is a fourth, `?cycleId=`, which is not a filter at all. See §7.2. |
| 10 | — | The frontend `/cycles` surface is **half-built**: no `useUpdateCycle`, no `useDeleteCycle`, and bulk update has no `cycleId`. Consolidating onto cycles includes net-new frontend work. See §7.0 and §7.3. |

One further defect found, **out of scope for this ticket but filed here so it is not lost**:
the burnup report reads `sprint_scope_events` (`projects-reports.service.ts:96-112`) and that table
has had no writer since 0156. Every sprint created after 0156 falls through to
`burnupFromCurrentMembership` (`:119`), which computes a *current-membership* burnup rather than an
event-sourced one. That is a silent accuracy defect independent of this consolidation. It should be
its own P1. This design deliberately does **not** fix it, because a consolidation that also changes
behaviour cannot be verified as behaviour-preserving.

---

## 1. Which identity survives

**`cycles` survives as the table. `sprints` is drained into it and retired.**

This is not the cheap answer. The sprint surface is far deeper than the cycle surface:

*Sprint surface (live behaviour):*
- velocity report — `src/modules/build/core/projects-velocity-report.ts:13-37`
- burnup report — `src/modules/build/core/projects-reports.service.ts:57-121`
- due sweep + `build.sprint.ending` notification — `src/modules/build/core/build-due-sweep.service.ts:126-133,170`
- `build.sprint.completed` outbox emit — `src/modules/build/execution/sprints.service.ts:124-141`
- its consumer — `src/modules/build/execution/build-sprint-completed-consumer.service.ts:21,60,69-80,94-102`
- notification event catalog — `src/modules/notifications/notification-events-build.catalog.ts:30,33`
- webhook dispatch `sprint.started` / `sprint.completed` — `sprints.service.ts:143-159`
- automation trigger vocabulary — `src/modules/build/core/dto/automation.schemas.ts:21-22`
- dashboard active-sprint card — `src/modules/dashboard/dashboard-project.service.ts:128-192`
- AI confirmable action `ticket.moveToSprint` — `src/modules/ai/core/confirm-actions/build-confirm-actions.ts:85-93`
- AI tool `moveTicketToSprint` — `src/modules/ai/core/tools/work-actions-tools.ts:189-220`
- entity-reads adapter `sprint` type — `src/modules/build/entity/build-entity-reads.service.ts:38,108-109,343-360`
- board/list ticket filters `sprintId` / `sprintIds` — `src/modules/build/core/dto/ticket.schemas.ts:69-70,115`
- bulk mutation — `src/modules/build/core/build-ticket-bulk-mutation.ts:65-76,108,121`
- activity vocabulary `sprint_changed` — `src/modules/build/core/projects-activity.service.ts:215-221`
- deep link `/build/:id/sprints` — `src/modules/build/core/build-app-paths.ts:28-30`
- per-project feature flag `settings.modules.sprints` — `src/db/schema/build/core.ts:50-60`

*Cycle surface:* list / create / update / delete (`src/modules/build/execution/cycles.service.ts`),
`tickets.cycle_id` as a filter, and the frontend route.

The reasoning, in order of weight:

1. **The product the user sees is cycles.** The frontend ships `/cycles` and no `/sprints` route
   (§7). Choosing `sprints` means writing a new `/sprints` route and deleting a shipped one —
   net-new UI work on top of the migration. Choosing `cycles` means the user-visible surface does
   not move at all. `build-app-paths.ts:28-30` already emits `/build/:projectId/sprints` into
   notification deep links; that link is **dead today** and gets fixed for free by this direction.

2. **The "sprints has the events surface" argument is void.** See §0 correction 1. The table has
   no writer. Retaining `sprints` to protect it protects nothing that is still being produced.

3. **`cycles` is typed; `sprints` is not.** `cycles.status` is the pg enum `cycle_status`
   (`src/db/schema/common/enums.ts:25`, used at `core.ts:165`). `sprints.status` is `text` plus a
   CHECK (`core.ts:111,125-128`) — the weaker construction. If `sprints` won, the text→enum
   conversion would be a full table rewrite plus `ANALYZE` (BE-78). If `cycles` wins, there is no
   conversion at all: the values are mapped once, during an INSERT.

4. **`cycles` dates are the right type.** `sprints.start_date` / `end_date` are `timestamp`
   (`core.ts:108-109`); `cycles` uses `date` (`core.ts:166-167`). The timestamp type is already
   being worked around — `build-due-sweep.service.ts:133` casts `${sprints.endDate}::date` to
   compare against `current_date + 1`. An iteration boundary is a calendar day, not an instant.

5. **`tickets.cycle_id` already exists, with its FK and index** (`ticket-core.ts:59,85,136`).
   Renaming `sprints` → `cycles` would still require merging two live ticket columns into one, so
   the hardest part of the work is identical in both directions. Only the direction of the copy
   differs, and only one direction leaves the frontend untouched.

What the survivor must *gain*, because it does not have it:
- `deleted_at` (soft delete) — `cycles` has none; `deleteCycle` hard-deletes (`cycles.service.ts:133-144`).
- Everything in the sprint surface list above, repointed.

The costs this decision accepts, stated plainly:
- 55 non-spec backend files and 46 spec files reference sprints; **120 non-test frontend files** do
  (counts measured; §9 and §7.0).
- `sprints.id` and `cycles.id` are **independent** `GENERATED ALWAYS AS IDENTITY` sequences
  (`core.ts:101` and `core.ts:157`). Sprint 7 and cycle 7 are unrelated rows. **Every id must be
  remapped, never copied.** This is the single largest source of risk in the plan and §4 is built
  around it.
- **The cycles surface is half-built and must be finished, not just repointed.** There is no cycle
  update or delete hook on the frontend, bulk ticket update has no `cycleId` at either end, and
  meetings, burnup and velocity are sprint-only with no cycle equivalent. §7.3 itemises this; §11
  prices it at 4 days of net-new work. **This is the strongest argument the other direction has**,
  and it is an argument about build cost, not about correctness: choosing `sprints` would instead
  require building a `/sprints` route and deleting a shipped one, and would leave the weaker column
  types in place permanently.

---

## 2. Field reconciliation

### 2.1 Status vocabulary

`sprints.status` is `text NOT NULL DEFAULT 'PLANNED'` with
`chk_sprints_status CHECK (status IN ('PLANNED','ACTIVE','COMPLETED'))` (`core.ts:111,125-128`).
`cycle_status` is `('draft','active','completed')` (`src/db/schema/common/enums.ts:25`).

| sprints | cycles | note |
|---|---|---|
| `PLANNED` | `draft` | Not identical in *origin* — `PLANNED` is written explicitly at create (`sprints.service.ts:79`), `draft` is the column default and `createCycle` never sets status (`cycles.service.ts:92-103`). Identical in *meaning*: "not started". |
| `ACTIVE` | `active` | — |
| `COMPLETED` | `completed` | — |

The mapping is **total**: the column is NOT NULL and the CHECK admits exactly those three values, so
there is no NULL branch and no unknown branch. The migration must nonetheless `RAISE` on an
unmapped value rather than defaulting to `draft` — the CHECK is only trustworthy if it was validated,
which is **UNVERIFIED** without a database.

API impact: `updateSprintSchema.status` is `z.enum(["PLANNED","ACTIVE","COMPLETED"])`
(`src/modules/build/execution/dto/iterations.schemas.ts:40`);
`updateCycleSchema.status` and `cycleListQuerySchema.status` are the lowercase triple
(`:90`, `:105`). After cutover the sprint route is gone and only the lowercase vocabulary remains.
Any client still sending `ACTIVE` gets a 400. That is a **breaking response/request contract change**
and must be released with the frontend, not before it.

### 2.2 `goal` → `description`

`sprints.goal text` nullable (`core.ts:110`) → `cycles.description text` nullable (`core.ts:164`).
Same type, same nullability. Direct copy, no transform.

One trap: `createCycleSchema.description` caps at 500 characters
(`iterations.schemas.ts:66-69`, mirrored at `:86-89`), while `createSprintSchema.goal` has no max
(`:22`). A migrated goal longer than 500 characters lands in a column with no length constraint, and
then **any subsequent PATCH that echoes the field 400s** — the row becomes un-editable through its own
API. Resolution: **raise the DTO cap to 2000 in the same release as the backfill.** Do not truncate;
the column is plain `text` and truncation is silent data loss.

### 2.3 `timestamp` → `date`

`sprints.start_date` / `end_date` are `timestamp` NOT NULL (`core.ts:108-109`).
`cycles.start_date` / `end_date` are `date` NOT NULL (`core.ts:166-167`).

`timestamp::date` is a narrowing that discards time-of-day. It is **safe and deterministic**: the
source is `timestamp` *without* time zone, so the cast truncates the stored wall clock with no
timezone conversion. It is also what the application already wants — see `build-due-sweep.service.ts:133`.

The visible consequence is a **response contract change**: `sprintRowSchema` / `sprintListItemSchema`
/ `sprintDetailSchema` (`src/modules/build/execution/dto/execution-response.schemas.ts:12-22,41,156-168`)
serialise an ISO timestamp today; cycle rows serialise `YYYY-MM-DD`. Every consumer that does
`new Date(row.startDate)` still works; every consumer that does string comparison or slicing does not.
This must be enumerated against the frontend before cutover.

### 2.4 `cycles.created_by` is NOT NULL and `sprints` has no creator

Verified: `cycles.createdBy` is `text NOT NULL REFERENCES users.id` (`core.ts:168-170`), exposed by
`cyclesRelations.creator` (`src/db/schema/build/relations.ts:64`) and projected by
`listCycles` (`cycles.service.ts:28`). `sprints` (`core.ts:98-118`) has **no creator column of any
kind** — not `created_by`, not an actor membership id.

There is no per-row creator to recover. `projects-activity.service.ts` logs `sprint_changed` on
*ticket* updates (`:215-221`), not sprint creation, so the activity log cannot supply one either.

**Concrete fallback, in this order, evaluated per sprint row:**

1. The project manager's user: `organization_members.user_id` for
   `projects.manager_membership_id` (`core.ts:39`, FK `fk_projects_manager_actor` at `core.ts:85-89`).
   Best available attribution — the person accountable for the project.
2. The organisation owner: the single `organization_members` row for that org with `is_owner = true`.
   Uniqueness is guaranteed by the partial unique index `uniq_org_members_single_owner`
   (`src/db/schema/common/auth.ts:104`). Existence is **not** guaranteed by any constraint.
3. If neither resolves, **`RAISE EXCEPTION` and abort the migration.** Do not invent a user id;
   `created_by` is a validated FK to `users.id` and a fabricated value fails the constraint anyway.

**Do not relax `created_by` to nullable.** It is read as non-null by the relation and the projection,
and narrowing a live NOT NULL is a contraction that BE-61's expand/contract discipline exists to avoid.
The fallback is cheap; the schema change is not.

A pre-flight query (§8) tells the operator how many rows will land on fallback 2 before they commit.

### 2.5 Soft delete

`cycles` must gain `deleted_at timestamptz` to match `sprints.deleted_at` (`core.ts:112`), because:
- soft-deleted sprints still own tickets (the FK is ON DELETE SET NULL, `ticket-core.ts:87`, so the
  ticket keeps pointing at the soft-deleted row), and §4 needs somewhere to put them;
- `deleteCycle` currently hard-deletes and nulls every ticket's `cycle_id` first
  (`cycles.service.ts:136-141`), which is destructive in a way `deleteSprint` is not
  (`sprints.service.ts:171`). Inheriting the *weaker* semantic during a consolidation would be a
  regression.

Every existing cycle query must gain `isNull(cycles.deletedAt)` at the same time
(`cycles.service.ts:15,76-87,114-117,126,139`), and the two cycle indexes
(`core.ts:179-180`) should become partial on `deleted_at IS NULL` to match the sprint indexes
(`core.ts:121,123`). The index reshape is its own migration (§3).

### 2.6 The single-active-cycle invariant is application-level only

`updateCycle` refuses a second `active` cycle per project (`cycles.service.ts:110-121`). There is
**no database constraint** enforcing it (`core.ts:177-182` declares only `fk_cycles_org_project`,
`idx_cycles_project`, `idx_cycles_org_status`, `uniq_cycles_org_id`). `sprints` has no equivalent
rule at all — nothing stops a project having two `ACTIVE` sprints.

So the backfill **can create data the application refuses to create**, and those rows then become
un-updatable: `updateCycle` would reject any PATCH setting `status = 'active'` on them and, worse,
the pre-existing duplicate makes the *other* cycle un-activatable too.

This is not a thing a migration may decide. §8 gives the pre-flight query; if it returns any rows,
the resolution is a product call made before the backfill runs, not inside it.

---

## 3. Migration sequence

### 3.1 House rules, as they actually apply here

- **BE-61** add nullable → backfill in batches → set NOT NULL; one purpose per migration.
  (CLAUDE.md:86)
- **BE-62** FK as `NOT VALID`, then `VALIDATE CONSTRAINT`. (CLAUDE.md:87) Template:
  `migrations/1142_fix_requisition_headcount_fk_set_null.sql`.
- **BE-63** NOT NULL via `CHECK (col IS NOT NULL) NOT VALID` → `VALIDATE` → `SET NOT NULL` → drop
  the CHECK separately. (CLAUDE.md:88) Template: `migrations/1140_exit_checklist_ownership.sql:29-33`.
- **BE-64** `SET lock_timeout = '5s';` as the first statement of every migration. (CLAUDE.md:89)
- **BE-65** indexes concurrently on large tables; name every constraint and index. (CLAUDE.md:90)
- **BE-68** `SET statement_timeout = 0;` on heavy `DO`-block migrations. (CLAUDE.md:93)
- **BE-70** split reconciliation into dependency-ordered migrations. (CLAUDE.md:95)
- **BE-71** a rollback for every destructive migration, at
  `migrations/rollback/<tag>.down.sql`, or an explicit `-- @irreversible` / `-- @data-loss`
  declaration in the forward file. (CLAUDE.md:96; gate contract at
  `src/scripts/check-migration-rollback.mjs:4-16`)

**On CONCURRENTLY.** `src/scripts/run-pending-migrations.mjs:78-95`:

```
const concurrent = /CREATE\s+(UNIQUE\s+)?INDEX\s+CONCURRENTLY/i.test(text);
...
if (concurrent) {  // statements applied one at a time, NO transaction
  for (const stmt of statementsOf(text)) await sql.unsafe(stmt);
} else {
  await sql.begin(async (tx) => { await tx.unsafe(text); ... });
}
```

The presence of the keyword anywhere in the file makes the **whole file** untransacted. A failure
halfway leaves the migration partially executed and *unrecorded* in `drizzle.__drizzle_migrations`.
`1134_qa_keyset_cursor_indexes.sql:17-18` chose plain `CREATE INDEX` for exactly this reason.

**The rule this design follows:** a `CREATE INDEX CONCURRENTLY` lives alone, in its own migration
file, containing nothing but `SET lock_timeout` and one `CREATE INDEX CONCURRENTLY IF NOT EXISTS`,
so that a failure is trivially re-runnable. Every other statement goes in a transacted file with
plain `CREATE INDEX`. Only `build.tickets` is large enough to warrant it.

**On schema qualification.** The runner sets
`search_path = '"$user", public, build_events, app'` (`run-pending-migrations.mjs:61`).
`build` is **not** on the path. Every `build.*` object must be written `"build"."name"`;
`build_events.*` may be written bare (as `0156` does) but is qualified here for clarity.
`organization_members`, `users`, `projects` resolve from `public`.

### 3.2 Numbering

`migrations/meta/_journal.json` head is `{"idx": 1030, "version": "7", "when": 1803000010420,
"tag": "1142_fix_requisition_headcount_fk_set_null"}`. Tags 1138 and 1139 do not exist.

Handwritten migrations need a journal entry or they never run.

| tag | idx | when |
|---|---|---|
| `1143_cycles_soft_delete` | 1031 | 1803000010430 |
| `1144_cycles_partial_indexes` | 1032 | 1803000010440 |
| `1145_sprint_cycle_map` | 1033 | 1803000010450 |
| `1146_cycles_backfill_from_sprints` | 1034 | 1803000010460 |
| `1147_tickets_cycle_id_backfill` | 1035 | 1803000010470 |
| `1148_project_meetings_cycle_id` | 1036 | 1803000010480 |
| `1149_test_runs_cycle_id` | 1037 | 1803000010490 |
| `1150_sprint_scope_events_cycle_id` | 1038 | 1803000010500 |
| `1151_tickets_cycle_id_reconcile` | 1039 | 1803000010510 |
| `1152_drop_tickets_sprint_id` | 1040 | 1803000010520 |
| `1153_drop_project_meetings_sprint_id` | 1041 | 1803000010530 |
| `1154_drop_test_runs_sprint_id` | 1042 | 1803000010540 |
| `1155_drop_sprint_scope_events_sprint_id` | 1043 | 1803000010550 |
| `1156_drop_sprints_table` | 1044 | 1803000010560 |

Fourteen migrations across **three releases**:

- **Phase A — expand (1143–1150).** Additive only. Safe to apply ahead of any code. Fully reversible.
- **Phase B — cut over (1151–1155).** 1151 applies *after* the code deploy. 1152–1155 are destructive
  and must land in the same commit as the Drizzle schema deletions (see the drop-column-safety note
  in §8).
- **Phase C — retire (1156).** A separate release, one retention window after Phase B.

---

### Phase A

#### `1143_cycles_soft_delete.sql`

```sql

SET lock_timeout = '5s';
--> statement-breakpoint

-- build.cycles has no soft delete; build.sprints does (src/db/schema/build/core.ts:112).
-- The consolidation drains sprints into cycles, including soft-deleted sprints whose
-- tickets still point at them via fk_tickets_org_sprint (ON DELETE SET NULL), so the
-- survivor needs somewhere to hold a deleted iteration. Nullable, no backfill: every
-- existing cycle is live by construction, because deleteCycle hard-deleted them
-- (src/modules/build/execution/cycles.service.ts:138).

ALTER TABLE "build"."cycles"
  ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;
```

`migrations/rollback/1143_cycles_soft_delete.down.sql`:

```sql
SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "build"."cycles" DROP COLUMN IF EXISTS "deleted_at";
```

> Ships with the `deletedAt` addition to `cycles` in `src/db/schema/build/core.ts:154-183` and the
> `isNull(cycles.deletedAt)` predicates in `cycles.service.ts`. The migration must be **applied
> before** that code deploys — Drizzle emits every declared column in an unprojected `findFirst`,
> so a declared-but-absent column is a 42703 on the first read.

#### `1144_cycles_partial_indexes.sql`

```sql

SET lock_timeout = '5s';
--> statement-breakpoint

-- Match the sprint index shape (core.ts:121,123): partial on deleted_at IS NULL so
-- soft-deleted iterations are not carried. Plain CREATE INDEX, not CONCURRENTLY:
-- the runner wraps a non-CONCURRENTLY file in one transaction and lock_timeout is
-- the fence (migrations/1134_qa_keyset_cursor_indexes.sql:17-18). build.cycles is a
-- per-project iteration table, one row per few weeks per project — small.

DROP INDEX IF EXISTS "build"."idx_cycles_project";
--> statement-breakpoint
DROP INDEX IF EXISTS "build"."idx_cycles_org_status";
--> statement-breakpoint

CREATE INDEX "idx_cycles_project"
  ON "build"."cycles" ("project_id")
  WHERE "deleted_at" IS NULL;
--> statement-breakpoint

CREATE INDEX "idx_cycles_org_status"
  ON "build"."cycles" ("org_id", "status")
  WHERE "deleted_at" IS NULL;
--> statement-breakpoint

-- Mirrors idx_sprints_org_project_velocity_cursor (core.ts:122-123), which the velocity
-- report keysets on (projects-velocity-report.ts:13,24). Without it the cutover moves that
-- report from an index scan to a seq scan on every page.

CREATE INDEX "idx_cycles_org_project_velocity_cursor"
  ON "build"."cycles" ("org_id", "project_id", "start_date" DESC, "id" DESC)
  WHERE "deleted_at" IS NULL AND "status" IN ('active', 'completed');
```

Rollback `1144_cycles_partial_indexes.down.sql`: drop the three, recreate the two originals
non-partial.

#### `1145_sprint_cycle_map.sql`

The id-remap ledger. `sprints.id` and `cycles.id` are independent identity sequences
(`core.ts:101`, `core.ts:157`), so nothing may assume `sprint_id = cycle_id`.
A table rather than a temporary column on `cycles`, for three reasons: it is the rollback source for
every Phase-B drop; it does not perturb `cycles` row width; and dropping a table is invisible to
`check:drop-column-safety`, so it can be retired on its own schedule.

```sql

SET lock_timeout = '5s';
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "build"."sprint_cycle_map" (
  "org_id"     text    NOT NULL,
  "sprint_id"  integer NOT NULL,
  "cycle_id"   integer NOT NULL,
  "resolution" text    NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "pk_sprint_cycle_map" PRIMARY KEY ("org_id", "sprint_id"),
  CONSTRAINT "uniq_sprint_cycle_map_cycle" UNIQUE ("org_id", "cycle_id"),
  CONSTRAINT "chk_sprint_cycle_map_resolution"
    CHECK ("resolution" IN ('created', 'matched_by_name'))
);
--> statement-breakpoint

ALTER TABLE "build"."sprint_cycle_map"
  ADD CONSTRAINT "fk_sprint_cycle_map_org"
  FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id")
  ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."sprint_cycle_map" VALIDATE CONSTRAINT "fk_sprint_cycle_map_org";
--> statement-breakpoint

ALTER TABLE "build"."sprint_cycle_map"
  ADD CONSTRAINT "fk_sprint_cycle_map_org_sprint"
  FOREIGN KEY ("org_id", "sprint_id") REFERENCES "build"."sprints"("org_id", "id")
  ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."sprint_cycle_map" VALIDATE CONSTRAINT "fk_sprint_cycle_map_org_sprint";
--> statement-breakpoint

ALTER TABLE "build"."sprint_cycle_map"
  ADD CONSTRAINT "fk_sprint_cycle_map_org_cycle"
  FOREIGN KEY ("org_id", "cycle_id") REFERENCES "build"."cycles"("org_id", "id")
  ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."sprint_cycle_map" VALIDATE CONSTRAINT "fk_sprint_cycle_map_org_cycle";
--> statement-breakpoint

-- BE-74: an explicit policy, because grants arrive via ALTER DEFAULT PRIVILEGES and a
-- missing policy reads org-wide and is silent. Same shape as 0156 (sprint_scope_events).
ALTER TABLE "build"."sprint_cycle_map" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "build"."sprint_cycle_map";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "build"."sprint_cycle_map"
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint

-- Explicit grants. A table created without them fails 42501, which reads as an RLS denial.
GRANT SELECT, INSERT, UPDATE, DELETE ON "build"."sprint_cycle_map" TO "streamline_app";
```

> `uniq_sprints_org_id` (`core.ts:124`) and `uniq_cycles_org_id` (`core.ts:181`) are the unique
> constraints these composite FKs target. Both exist.
> The grantee role name is copied from the house convention in `CLAUDE.md:104` (BE-76,
> `streamline_app`); **UNVERIFIED** against the live role set — confirm with
> `\dp build.cycles` on the target database before applying.

Rollback: `DROP TABLE IF EXISTS "build"."sprint_cycle_map";`

#### `1146_cycles_backfill_from_sprints.sql`

One cycle per sprint that has no counterpart; a map row for every sprint including the ones that do.

```sql

SET lock_timeout = '5s';
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint

DO $$
DECLARE
  batch    integer := 500;
  moved    integer;
  unmapped integer;
BEGIN
  -- Pass 1: sprints that already have a same-named cycle in the same project map onto it
  -- rather than duplicating. build.cycles has no unique constraint on name (core.ts:177-182),
  -- so a project with two same-named cycles resolves to the lowest id, deterministically.
  INSERT INTO "build"."sprint_cycle_map" ("org_id", "sprint_id", "cycle_id", "resolution")
  SELECT s.org_id, s.id, c.cycle_id, 'matched_by_name'
  FROM "build"."sprints" s
  CROSS JOIN LATERAL (
    SELECT min(c2.id) AS cycle_id
    FROM "build"."cycles" c2
    WHERE c2.org_id = s.org_id
      AND c2.project_id = s.project_id
      AND c2.deleted_at IS NULL
      AND lower(btrim(c2.name)) = lower(btrim(s.name))
  ) c
  WHERE c.cycle_id IS NOT NULL
  ON CONFLICT ("org_id", "sprint_id") DO NOTHING;

  -- Pass 2: everything else gets a new cycle, in batches.
  LOOP
    WITH todo AS (
      SELECT s.id, s.org_id, s.project_id, s.name, s.goal, s.status,
             s.start_date, s.end_date, s.deleted_at, s.created_at, s.updated_at,
             p.manager_membership_id
      FROM "build"."sprints" s
      JOIN "build"."projects" p
        ON p.org_id = s.org_id AND p.id = s.project_id
      WHERE NOT EXISTS (
        SELECT 1 FROM "build"."sprint_cycle_map" m
        WHERE m.org_id = s.org_id AND m.sprint_id = s.id
      )
      ORDER BY s.org_id, s.id
      LIMIT batch
    ),
    resolved AS (
      SELECT t.*,
             COALESCE(
               (SELECT om.user_id FROM "public"."organization_members" om
                 WHERE om.org_id = t.org_id AND om.id = t.manager_membership_id),
               (SELECT om.user_id FROM "public"."organization_members" om
                 WHERE om.org_id = t.org_id AND om.is_owner = true LIMIT 1)
             ) AS creator_user_id
      FROM todo t
    ),
    ins AS (
      INSERT INTO "build"."cycles"
        ("org_id", "project_id", "name", "description", "status",
         "start_date", "end_date", "created_by", "deleted_at", "created_at", "updated_at")
      SELECT r.org_id, r.project_id, r.name, r.goal,
             CASE r.status
               WHEN 'PLANNED'   THEN 'draft'::cycle_status
               WHEN 'ACTIVE'    THEN 'active'::cycle_status
               WHEN 'COMPLETED' THEN 'completed'::cycle_status
             END,
             r.start_date::date, r.end_date::date,
             r.creator_user_id, r.deleted_at, r.created_at, r.updated_at
      FROM resolved r
      RETURNING "id" AS cycle_id, "org_id", "project_id", "name", "start_date"
    )
    INSERT INTO "build"."sprint_cycle_map" ("org_id", "sprint_id", "cycle_id", "resolution")
    SELECT r.org_id, r.id, i.cycle_id, 'created'
    FROM resolved r
    JOIN ins i
      ON i.org_id = r.org_id AND i.project_id = r.project_id
     AND i.name = r.name AND i.start_date = r.start_date::date;

    GET DIAGNOSTICS moved = ROW_COUNT;
    EXIT WHEN moved = 0;
    RAISE NOTICE 'sprint->cycle backfill: % rows', moved;
  END LOOP;

  -- Fail loudly rather than leaving a partial mapping behind.
  SELECT count(*) INTO unmapped
  FROM "build"."sprints" s
  WHERE NOT EXISTS (
    SELECT 1 FROM "build"."sprint_cycle_map" m
    WHERE m.org_id = s.org_id AND m.sprint_id = s.id
  );
  IF unmapped > 0 THEN
    RAISE EXCEPTION 'sprint->cycle backfill incomplete: % sprints unmapped '
      '(status outside the PLANNED/ACTIVE/COMPLETED triple, or no project manager '
      'and no org owner to satisfy cycles.created_by NOT NULL)', unmapped;
  END IF;
END $$;
```

Three properties worth stating explicitly:

- **Soft-deleted sprints get a soft-deleted cycle.** `s.deleted_at` is carried through, which is
  only possible because 1143 ran first. This is what keeps tickets pointing at a soft-deleted
  iteration from silently losing their association in §4.
- **`created_at` / `updated_at` are carried through.** `cycles.created_at` defaults to `now()`
  (`core.ts:171`); an explicit value overrides it. Without this every migrated cycle would claim to
  have been created on migration day. Note that `created_at` is transaction-start time in Postgres,
  not insert time — irrelevant here because the value is supplied.
- **The `ins`→`map` join is on `(org_id, project_id, name, start_date)`, not on a returned sprint id**,
  because `RETURNING` in a data-modifying CTE cannot project a column from the source CTE. Two sprints
  in the same project with the same name *and* the same start date would make this join ambiguous.
  §8 gives the pre-flight query that proves that cannot happen; if it can, the loop must be rewritten
  as a row-at-a-time `FOR` loop instead. **This is the single most fragile statement in the plan.**

Rollback `1146_cycles_backfill_from_sprints.down.sql`:

```sql
SET lock_timeout = '5s';
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
DELETE FROM "build"."cycles" c
USING "build"."sprint_cycle_map" m
WHERE m.org_id = c.org_id AND m.cycle_id = c.id AND m.resolution = 'created';
--> statement-breakpoint
DELETE FROM "build"."sprint_cycle_map";
```

> Reversible only because `resolution` distinguishes the cycles this migration created from the
> ones it merely matched. Deleting on the map alone would destroy pre-existing user data.

#### `1147_tickets_cycle_id_backfill.sql`

```sql

SET lock_timeout = '5s';
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint

-- Only rows where cycle_id IS NULL. A ticket carrying BOTH a sprint_id and a different
-- cycle_id is a genuine conflict: cycle_id is what the shipped /cycles UI writes, so it is
-- the more recent user intent and it wins. The pre-flight query in the design doc counts
-- those rows so the operator sees the number before committing.

DO $$
DECLARE
  batch integer := 5000;
  moved integer;
BEGIN
  LOOP
    WITH todo AS (
      SELECT t.id, t.org_id, m.cycle_id
      FROM "build"."tickets" t
      JOIN "build"."sprint_cycle_map" m
        ON m.org_id = t.org_id AND m.sprint_id = t.sprint_id
      WHERE t.sprint_id IS NOT NULL
        AND t.cycle_id IS NULL
      LIMIT batch
    )
    UPDATE "build"."tickets" t
    SET "cycle_id" = todo.cycle_id
    FROM todo
    WHERE t.id = todo.id AND t.org_id = todo.org_id;

    GET DIAGNOSTICS moved = ROW_COUNT;
    EXIT WHEN moved = 0;
    RAISE NOTICE 'tickets.cycle_id backfill: % rows', moved;
  END LOOP;
END $$;
--> statement-breakpoint

-- BE-78: the update rewrites a large fraction of the table's rows.
ANALYZE "build"."tickets";
```

Rollback `1147_tickets_cycle_id_backfill.down.sql`:

```sql
SET lock_timeout = '5s';
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
UPDATE "build"."tickets" t
SET "cycle_id" = NULL
FROM "build"."sprint_cycle_map" m
WHERE m.org_id = t.org_id
  AND m.cycle_id = t.cycle_id
  AND m.sprint_id = t.sprint_id;
--> statement-breakpoint
ANALYZE "build"."tickets";
```

> The rollback nulls only rows where `cycle_id` and `sprint_id` agree *through the map* — a ticket
> whose `cycle_id` was set by a user is untouched, because its `sprint_id` will not map to that cycle.

#### `1148_project_meetings_cycle_id.sql`

```sql

SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE "build"."project_meetings"
  ADD COLUMN IF NOT EXISTS "cycle_id" integer;
--> statement-breakpoint

ALTER TABLE "build"."project_meetings"
  ADD CONSTRAINT "fk_project_meetings_org_cycle"
  FOREIGN KEY ("org_id", "cycle_id") REFERENCES "build"."cycles"("org_id", "id")
  ON DELETE SET NULL ("cycle_id")
  NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."project_meetings" VALIDATE CONSTRAINT "fk_project_meetings_org_cycle";
--> statement-breakpoint

-- Not batched and not a separate migration: project_meetings holds one row per meeting,
-- an order of magnitude below build.tickets, and cycle_id stays nullable forever (it
-- mirrors sprint_id, meetings.ts:39) so there is no NOT NULL step for BE-61 to separate.
UPDATE "build"."project_meetings" pm
SET "cycle_id" = m.cycle_id
FROM "build"."sprint_cycle_map" m
WHERE m.org_id = pm.org_id AND m.sprint_id = pm.sprint_id
  AND pm.sprint_id IS NOT NULL AND pm.cycle_id IS NULL;
```

> `ON DELETE SET NULL ("cycle_id")` carries an explicit column list, matching
> `migrations/1142_fix_requisition_headcount_fk_set_null.sql`. Without it, SET NULL writes NULL to
> every constrained column including `org_id`, which is NOT NULL, and the parent delete raises 23502.

Rollback: drop the constraint, drop the column.

#### `1149_test_runs_cycle_id.sql`

Identical shape for `build.test_runs` (`src/db/schema/build/qa.ts:78,95,97`), plus
`CREATE INDEX "idx_test_runs_cycle" ON "build"."test_runs" ("cycle_id");` to mirror
`idx_test_runs_sprint` (`qa.ts:97`).

#### `1150_sprint_scope_events_cycle_id.sql`

Same shape for `build_events.sprint_scope_events` (`src/db/schema/build/sprint-events.ts:22,35`),
plus the read index that `projects-reports.service.ts:103-112` needs:

```sql
CREATE INDEX "idx_sprint_scope_events_org_cycle_created"
  ON "build_events"."sprint_scope_events" ("org_id", "cycle_id", "created_at");
```

The parent FK is `ON DELETE CASCADE` on the sprint side (`sprint-events.ts:35`); the cycle-side FK
must be `ON DELETE CASCADE` too, not SET NULL, or the column would become nullable-orphaned on
cycle delete. But `cycles` no longer hard-deletes after 1143 + the service change, so this is
belt-and-braces. **Do not rename the table.** Its name is pinned in the membership artifact catalog
(`src/modules/organization/core/membership-artifact-catalog/build.artifacts.ts:55-62`, `table:
"sprint_scope_events"`) and asserted by `src/modules/organization/core/membership-artifacts.spec.ts:175`.
A rename is cosmetic debt for a separate ticket.

---

### Cutover (between 1150 and 1151)

The code deploy. Between 1147 and this deploy, a ticket written with `sprint_id` acquires no
`cycle_id` — the backfill is a snapshot, not a trigger.

**Dual-write, not a database trigger.** For one release, the three ticket write paths resolve
`sprintId` through `build.sprint_cycle_map` and write **both** columns:
`src/modules/build/core/projects-tickets-create.service.ts:136-138`,
`projects-tickets-update.service.ts:152,156,334,338`,
`build-ticket-bulk-mutation.ts:108,121`.

Chosen over a DB trigger because a trigger is invisible to `typecheck`, to every gate, and to every
spec, and because the memory of this codebase already records `after-commit hooks have no tenant
context` — a trigger firing under RLS on a table whose policy reads `app.current_org_id()` is a
class of failure this design should not introduce to save three edits.

#### `1151_tickets_cycle_id_reconcile.sql`

A byte-for-byte re-run of 1147's `DO` block under a new tag, closing the dual-write window.
It is a **new file**: BE-60 forbids editing an applied migration, and re-running 1147 would be a
hash mismatch the runner silently skips.

---

### Phase B — contraction

Each of 1152–1155 must land **in the same commit** as the corresponding Drizzle schema deletion.
`check:drop-column-safety` fails when an *unapplied* migration drops a column the schema still
declares (`src/scripts/check-drop-column-safety.mjs:1-8`), and the inverse — schema deleted, column
still present — is a 42703 on every unprojected read.

#### `1152_drop_tickets_sprint_id.sql`

```sql

SET lock_timeout = '5s';
--> statement-breakpoint

-- Order matters: the index and the FK both depend on the column, and dropping the column
-- first would cascade them implicitly, which is invisible in the rollback.
ALTER TABLE "build"."tickets" DROP CONSTRAINT IF EXISTS "fk_tickets_org_sprint";
--> statement-breakpoint
DROP INDEX IF EXISTS "build"."idx_tickets_sprint";
--> statement-breakpoint
ALTER TABLE "build"."tickets" DROP COLUMN IF EXISTS "sprint_id";
--> statement-breakpoint
ANALYZE "build"."tickets";
```

`migrations/rollback/1152_drop_tickets_sprint_id.down.sql`:

```sql
SET lock_timeout = '5s';
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
ALTER TABLE "build"."tickets" ADD COLUMN IF NOT EXISTS "sprint_id" integer;
--> statement-breakpoint

-- Values are recoverable because build.sprints and build.sprint_cycle_map both survive
-- Phase B. This is why the sprints table is dropped in Phase C and not here.
UPDATE "build"."tickets" t
SET "sprint_id" = m.sprint_id
FROM "build"."sprint_cycle_map" m
WHERE m.org_id = t.org_id AND m.cycle_id = t.cycle_id;
--> statement-breakpoint

CREATE INDEX "idx_tickets_sprint" ON "build"."tickets" ("sprint_id");
--> statement-breakpoint
ALTER TABLE "build"."tickets"
  ADD CONSTRAINT "fk_tickets_org_sprint"
  FOREIGN KEY ("org_id", "sprint_id") REFERENCES "build"."sprints"("org_id", "id")
  ON DELETE SET NULL ("sprint_id")
  NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."tickets" VALIDATE CONSTRAINT "fk_tickets_org_sprint";
--> statement-breakpoint
ANALYZE "build"."tickets";
```

> This rollback is **lossy in one direction only**: a ticket whose `cycle_id` was set by a user
> after cutover, and which therefore has no map row, comes back with `sprint_id = NULL`. That is
> correct — it never had a sprint. No row loses a value it previously held.

`1153` / `1154` / `1155` follow the same three-step shape (drop FK, drop index where one exists,
drop column) against `build.project_meetings`, `build.test_runs`, and
`build_events.sprint_scope_events`, each with a value-restoring rollback through the map.

### Phase C — retirement

#### `1156_drop_sprints_table.sql`

```sql
-- @irreversible
-- build.sprints is drained; every value it held lives in build.cycles and the
-- id correspondence lives in build.sprint_cycle_map, which is deliberately
-- retained as the historical ledger. The table itself cannot be reconstructed.

SET lock_timeout = '5s';
--> statement-breakpoint

-- Drop the map's sprint-side FK first so the ledger survives the parent.
ALTER TABLE "build"."sprint_cycle_map"
  DROP CONSTRAINT IF EXISTS "fk_sprint_cycle_map_org_sprint";
--> statement-breakpoint

DROP TABLE IF EXISTS "build"."sprints";
```

> `-- @irreversible` is the machine-readable declaration `check:migration-rollback` accepts in lieu
> of a `.down.sql` (`src/scripts/check-migration-rollback.mjs:6-9`).
> Ship this only after a full retention window in which Phase B has been stable, because it is the
> point of no return for `1152–1155`'s rollbacks.

---

## 4. The `tickets.sprint_id` → `cycle_id` backfill

The mechanics are 1147 above. The decisions behind it:

**Tickets pointing at a sprint with no cycle counterpart.** After 1146 this set is **empty by
construction** — 1146 maps *every* sprint row, live and soft-deleted, and `RAISE`s if any remains
unmapped. The case the brief anticipates is really two cases:

1. *Ticket points at a soft-deleted sprint.* 1143 exists precisely so this survives: the sprint's
   cycle is created carrying `deleted_at`, and the ticket points at a soft-deleted cycle exactly as
   it pointed at a soft-deleted sprint. The alternative — nulling `cycle_id` — silently destroys the
   ticket↔iteration history that the `sprint_changed` activity rows
   (`projects-activity.service.ts:215-221`) refer to.
2. *Ticket points at a hard-deleted sprint.* Cannot happen. `fk_tickets_org_sprint` is
   `ON DELETE SET NULL` (`ticket-core.ts:87`), so a hard delete already nulled the column. There are
   no orphans to handle.

**Tickets carrying both, disagreeing.** 1147 writes only where `cycle_id IS NULL`, so `cycle_id`
wins and `sprint_id` is discarded. Justification: `cycle_id` is what the shipped `/cycles` UI writes,
making it the more recent expression of intent. The count is surfaced by a pre-flight query (§8)
so the operator decides with a number in front of them, not after the fact.

**Order of FK and index drops** (1152): constraint, then index, then column. Dropping the column
first would cascade both implicitly. Postgres permits it; the problem is that the cascade is not
written down, so the rollback author has nothing to reverse and `check:migration-rollback`'s type-name
cross-check has nothing to match. Explicit drops make the rollback mechanically derivable from the
forward file.

**Batch size 5000** on `build.tickets`, 500 on `build.cycles`. These are **UNVERIFIED** —
row counts are unknown without a database. Tune from `SELECT count(*) FROM build.tickets WHERE
sprint_id IS NOT NULL;` before the first run.

---

## 5. `sprint_scope_events` and the completed-sprint consumer

### The table: **repoint, do not retire**

`build_events.sprint_scope_events` (`src/db/schema/build/sprint-events.ts:15-49`) holds real rows —
the 0156 backfill (`migrations/0156_sprint_scope_events.sql:105-135`) inserted one `added` event per
ticket that was in a sprint on that day. Retiring the table discards that history.

It is also true that the table has had **no writer since** (§0 correction 1), so the history is
frozen. That makes the repoint *cheap*: one nullable integer, one FK, one backfill through the map,
one index — `1150` above. It does not make retirement correct.

Recommendation: **repoint in 1150, drop `sprint_id` in 1155, keep the table and its name.**
File the missing-writer defect separately. A consolidation that also deletes a data surface cannot
be reviewed as behaviour-preserving, and this one already has enough moving parts.

The read at `projects-reports.service.ts:96-112` changes `sprintScopeEvents.sprintId` →
`cycleId` and the surrounding sprint lookup (`:61-80`) becomes a cycle lookup. The zero-events
fallback at `:119` (`burnupFromCurrentMembership`) is untouched.

### `build-sprint-completed-consumer.service.ts`: **keep, repoint the query, keep the event key**

Three separate things travel under the name "sprint completed" and they must not be renamed together:

| thing | where | rename? |
|---|---|---|
| Outbox `eventType: "build.sprint.completed"` | `sprints.service.ts:131`, consumer `:21` | **No** |
| Notification event key `build.sprint.completed` | `src/modules/notifications/notification-events-build.catalog.ts:33` (and `build.sprint.ending` at `:30`) | **No** |
| Automation trigger `sprint.started` / `sprint.completed` | `src/modules/build/core/dto/automation.schemas.ts:21-22` | **No** |
| Webhook event names `sprint.started` / `sprint.completed` | `sprints.service.ts:143-159` | **No** |

All four are **persisted or externally observed strings**. The notification key is a catalog entry
with per-user preference rows keyed on it; the automation trigger is stored in the automation row;
the webhook name is on the wire to a customer's endpoint. Renaming any of them is a data migration
plus a customer-visible break, for zero user-visible benefit. The names become historical. That is
acceptable and normal.

What *does* change:

- `buildSprintCompletedPayloadSchema` (`src/modules/build/execution/dto/build-sprint-completed-payload.schema.ts:3-9`)
  gains `cycleId` and keeps `sprintId` **optional** for one retention window, because outbox rows
  written before the deploy are already in the queue carrying `sprintId`. The consumer reads
  `cycleId ?? sprintId`-resolved-through-the-map. Dropping `sprintId` from the schema on deploy day
  makes every in-flight event fail `safeParse` and get marked `FAILED` at
  `build-sprint-completed-consumer.service.ts:51-58` — silently, into the inbox, with a log line and
  no alert.
- The recipient query at `:69-80` moves from `eq(tickets.sprintId, sprintId)` to
  `eq(tickets.cycleId, cycleId)`.
- `entityType: "sprint"` at `:99` — **leave it.** It is a notification-row discriminator that
  historical rows already carry; changing it orphans the rendering of every past notification.
  Verified that `src/modules/build/scope-directory/` contains no `sprint` entity registration
  outside its spec (`scope-directory.service.spec.ts:134`), so there is no second catalog to keep in step.
- The emit site moves with `updateSprint` → `updateCycle` (`sprints.service.ts:124-141` folds into
  `cycles.service.ts:108-131`), and its trigger condition changes from
  `input.status === "COMPLETED" && before.status !== "COMPLETED"` to the lowercase pair.

`CONSUMER_NAME = "build:sprint-completed"` (`:15`) is the inbox dedupe key. **Do not rename it** —
it is the primary key of every processed-event row; a rename makes every already-processed event
look unprocessed and the consumer re-notifies the entire history on first boot.

---

## 6. Permission keys

**Recommendation: keep `build:sprints:view` and `build:sprints:manage`. Do not rename to
`build:cycles:*`. Fix the inconsistency instead.**

### Why not rename

1. **The keys are persisted, not merely declared.** Grant rows reference the key by name.
   BE-111 (`CLAUDE.md:149`): a new key violates the FK until catalog sync runs, and grants may never
   be backfilled by migration. BE-114 (`CLAUDE.md:152`): every permission mutation must call
   `bumpPermissionsVersion` in the same transaction. A rename is therefore a live grant migration for
   every organisation plus a reconciler pass — cost far beyond a string edit.

2. **BE-112 makes it a six-file catalog change with a ~20-site blast radius.** `CLAUDE.md:150`:
   a key must land in the backend catalog and the frontend catalog together or `useCan` is false
   forever (gate: `check:permission-keys`). The declaration sites:
   - backend catalog — `src/modules/rbac/permissions/shared.ts:97-107`
   - backend role templates — `src/modules/rbac/role-templates-build.constants.ts:15,79,80`
   - backend entity adapter — `src/modules/build/entity/build-entity-reads.service.ts:38`
     (pinned by `src/modules/build/entity/build-entity.adapter.spec.ts:132`)
   - frontend **type union** — `frontend/lib/rbac/permissions/permission-key-foundation.ts:87-88`
     (the file `check-permission-keys.mjs:117-121` reads)
   - frontend **runtime descriptors** — `frontend/lib/rbac/permissions/shared.ts:76-87`
     (`resource: "build:sprints"` at `:78,:84` is the anchor a rename has to move)
   - frontend **JSON contract** — `frontend/contracts/permission-catalog.json:164-165`

   These are three separate frontend surfaces. A rename touching only the union passes
   `check:permission-keys` and still leaves `useCan` false, because the runtime descriptors are what
   `useCan` reads. Three further frontend gates enforce parity and would all bite on a partial
   rename: `check:permission-catalog`, `check:permission-binding`, `check-route-access-contract.mjs`
   (§7.6).

   The usage sites that must move with them include the cycles route gate
   (`frontend/lib/rbac/route-access/route-access-extension-entries.ts:265-269`), the Cycles nav entry
   (`frontend/lib/build/nav/build-project-catalog.ts:80`), `useCycles`
   (`frontend/hooks/api/build/advanced.ts:83`), both cycle pages
   (`cycles-page.tsx:138`, `cycle-detail-page.tsx:74`) and eight test files.

3. **The frontend has already made this decision, deliberately.**
   `frontend/lib/rbac/route-access/route-access-extension-entries.ts:268` states the rule in its own
   `reason` field: *"Cycles supersede sprints and share their iteration-planning read key; the
   generic build:view let a role without sprint access open cycle planning."* Renaming the key
   reverses a choice that was made on purpose and documented at the site.

4. **Zero user-visible benefit.** The key string is never rendered.

### What to fix instead — this is a real defect

`CyclesController` reads with one key family and writes with another:

| route | key | file:line |
|---|---|---|
| `GET  build/:projectId/cycles` | `build:sprints:view` | `iterations.controller.ts:138` |
| `POST build/:projectId/cycles` | `build:workspace:manage` | `:151` |
| `PATCH build/:projectId/cycles/:cycleId` | `build:workspace:manage` | `:164` |
| `DELETE build/:projectId/cycles/:cycleId` | `build:workspace:manage` | `:177` |

Consequences today: a role holding `build:sprints:manage` can manage sprints but **cannot** manage
cycles; and `build:workspace:manage` is not cycle-specific — it also gates the entire Modules
controller (`:209,221,235`), so granting cycle management silently grants module management.
The frontend mirrors the split exactly: `useCreateCycle` gates on `build:workspace:manage`
(`frontend/hooks/api/build/advanced.ts:95`) and the cycles-page create button on the same key
(`frontend/features/build/cycles/cycles-page.tsx:125`), while the read path uses
`build:sprints:view`.

**Change `:151`, `:164`, `:177` to `build:sprints:manage`.** That is a three-decorator edit on the
backend plus two on the frontend (`advanced.ts:95`, `cycles-page.tsx:125`). No catalog change, no
grant migration, no `bumpPermissionsVersion`, and no new key for BE-112 to police. It makes the
surviving identity governed by exactly one key pair, which is the outcome a rename was reaching for.

Ship it in Phase A, independently — it is correct regardless of whether the consolidation proceeds.

If a rename is ever genuinely wanted, it is its own ticket with an alias period: add
`build:cycles:*` to both catalogs, grant it alongside the old key via role-template widening
(BE-111), let `RoleGrantReconcilerService` converge at boot, run both keys on the routes for one
release, then remove the old.

---

## 7. Frontend cutover

All paths in this section are relative to `D:/projects/personal/Streamlineos/frontend` and were
verified by a read-only sweep of that repository.

### 7.0 Corrections to the brief's frontend facts

| brief said | sweep found |
|---|---|
| `use-board-url-state.ts:75` reads `?cycle=` and `?sprint=` | They are at **`:66` and `:67`**. `:70-78` is a *different* param, `?cycleId=`, which seeds the create-ticket dialog's default cycle — not a filter. |
| both `?cycle=` and `?sprint=` | There are **two incompatible sprint param conventions**. The board uses `?sprint=` (`use-board-url-state.ts:67`); every filter-bar surface uses **`?sprintId=`** (`features/build/shared/use-ticket-filter-params.ts:20`). Cycle is `?cycle=` on both. So collapsing "the dual params" is actually collapsing **three**. |
| ~40 frontend files reference sprint | **164 files** contain `sprint` case-insensitively; **120** excluding `*.test.*`; **63** contain the literal `sprintId`. The estimate in §11 is revised accordingly. |
| no `sprints/` route exists | Correct, and it was **deleted**, not never-built — commit `9662485c9 refactor: remove sprint-related components and schemas` removed `app/(authenticated)/build/[projectId]/sprints`. Every sprint hook, type, contract and UI control survived the route's removal. Stale `.next/dev/server/.../sprints/` manifests remain on disk and are not source. |
| frontend permission catalog | There are **three** declaration sites, not one: `contracts/permission-catalog.json:164-165`, `lib/rbac/permissions/permission-key-foundation.ts:87-88` (the union `check-permission-keys.mjs` reads), and `lib/rbac/permissions/shared.ts:76-87` (the runtime descriptors). |

Two findings that change the shape of the work:

- **`useCycles` is already gated on `build:sprints:view`** (`hooks/api/build/advanced.ts:83`), as are
  the cycles page (`features/build/cycles/cycles-page.tsx:138`), the cycle detail page (`:74` of
  `cycle-detail-page.tsx`), the nav entry (`lib/build/nav/build-project-catalog.ts:80`) and the route
  gate (`lib/rbac/route-access/route-access-extension-entries.ts:267`). That last file already
  carries the reasoning in its own `reason` string at `:268`:
  *"Cycles supersede sprints and share their iteration-planning read key; the generic build:view let
  a role without sprint access open cycle planning."* The decision in §6 is therefore not a new
  policy — it is the policy the frontend already shipped.
- **The cycles surface is half-built.** There is no `useUpdateCycle` and no `useDeleteCycle`
  (`hooks/api/build/advanced.ts` defines only `useCycles:79` and `useCreateCycle:93`), even though
  the backend exposes `PATCH` and `DELETE` (`iterations.controller.ts:163,176`;
  `contracts/openapi.json` `"/build/{projectId}/cycles/{cycleId}"`). `cycle-detail-page.tsx:65`
  fetches the whole list and filters client-side. **Consolidating onto cycles means building the
  cycle edit/delete UI that does not exist yet**, and that work is not in the migration — it is
  net-new frontend.

### 7.1 The route stays where it is

The frontend serves `/cycles` at
`app/(authenticated)/build/[projectId]/cycles/page.tsx` and `.../[cycleId]/page.tsx`, registered
`KEEP` in `lib/build/build-route-manifest.ts:49-50`. The cutover moves no page. It removes sprint
references from pages that already live under the cycles/board vocabulary, and fills the gaps listed
in 7.0.

### 7.2 Collapsing `?cycle=` / `?sprint=` / `?sprintId=` without breaking deep links

The hard constraint is arithmetic, not cosmetic:

> **A `?sprint=7` deep link cannot be reinterpreted as `?cycle=7`.** `sprints.id` and `cycles.id`
> are independent identity sequences (`src/db/schema/build/core.ts:101,157`). Sprint 7 and cycle 7
> are different rows, usually in different projects. Rewriting the param client-side would silently
> show the user the wrong iteration — the worst failure mode available, because it renders
> successfully.

There is a second constraint the brief did not surface: **the two vocabularies have different
arities.** `cycle` is `arity: "multi"` and `sprint` is `arity: "single"`
(`features/build/shared/use-ticket-filter-params.ts:18,20`). On the wire they become
`params.cycleId = filters.cycle` and `params.sprintIds = filters.sprint`
(`hooks/api/build/ticket-queries.ts:91-92`, pinned by
`hooks/api/build/board-server-filter.test.ts:99,108` asserting `sprintIds: "3,4"`). The type
declarations disagree with both: `TicketFilters.sprintId` is `number` while `TicketFilters.cycleId`
is `string` (`types/projects/tasks.ts:224-225`). Collapsing onto cycle therefore **widens** sprint
from single to multi, which is a UI behaviour change in the filter bar, not just a rename.

Resolution, in three releases:

1. **Backend accepts `sprintId` / `sprintIds` as deprecated aliases for exactly one release.**
   They already exist in the ticket list query schemas
   (`src/modules/build/core/dto/ticket.schemas.ts:69-70,115`). Keep them declared; change
   `src/modules/build/core/projects-work-query.service.ts:133,254` to resolve them through
   `build.sprint_cycle_map` into `cycle_id` rather than filtering on `tickets.sprint_id`. A stale
   deep link then resolves to the *correct* cycle, server-side, through the authoritative mapping.
   This is the only place that translation can be correct, because it needs the map.
2. **The frontend stops emitting all three sprint params at cutover** and emits only `?cycle=`.
   It continues to *read* `?sprint=` (`use-board-url-state.ts:67`) and `?sprintId=`
   (`use-ticket-filter-params.ts:20`) and forward the raw value to the backend **unrewritten**
   for that one release. Concretely: `ticket-queries.ts:92` keeps sending `params.sprintIds`, the
   server resolves it, and the UI shows the resulting cycle. Saved views, which persist both keys
   independently (`use-board-url-state.ts:272-273`), get the same treatment — read both, write one.
3. **Release N+1 deletes** the alias in `ticket.schemas.ts`, the resolution branch in
   `projects-work-query.service.ts`, and both readers on the frontend. Phase C
   (`1156_drop_sprints_table`) should not ship before this. The map *rows* survive 1156 — only
   `fk_sprint_cycle_map_org_sprint` is dropped — so the constraint is soft, but a sprint id is
   meaningless to every other part of the system by then and the alias should not outlive it.

Do **not** attempt a rewrite in middleware or in the client. It needs a database lookup to be
correct, and a param rewrite that needs a database lookup is a backend concern wearing a frontend hat.

### 7.3 Feature gaps that must be closed *before* cutover, not after

These are places where the sprint surface does something the cycle surface cannot. Each one is a
regression the day `sprints` is removed, and none of them is solved by the migration.

| gap | evidence | cost |
|---|---|---|
| **Bulk update has no `cycleId`.** `BulkUpdateTicketsInput` carries `sprintId?: number \| null` (`hooks/api/build/ticket-create-rank-mutations.ts:249`) and no cycle field. The bulk bar's "Move to Sprint" select (`features/build/backlog/bulk-action-bar.tsx:56,237-246`) calls `handleBulkUpdate({ sprintId })` from `project-backlog-page.tsx:171-172` and `project-board-page.tsx:131-132`. | Backend side exists: `build-ticket-bulk-mutation.ts:65-76,108,121` validates and writes `sprintId` only. | Both ends. The backend bulk path must learn `cycleId` with the same in-project validation the sprint path has. |
| **No cycle edit/delete UI.** §7.0. | `hooks/api/build/advanced.ts` has no update/delete hook. | Net-new frontend: two hooks plus the controls. |
| **Meetings are sprint-only.** `sprintId` is a persisted FK on a meeting (`types/projects/meetings.ts:30,86,102`; `hooks/api/build/meetings-schema.ts:18`), drives the agenda generator (`features/build/meetings/generate-agenda.ts:4,27-43` filters `t.sprintId === sprint.id`) and the active-sprint derivation (`meetings-list-page.tsx:92-94`, `s.status === "ACTIVE"`). | Backend column added by migration `1148`. | Frontend must move to `cycleId` and to the lowercase `"active"` status. |
| **Burnup and velocity are sprint-only.** `features/build/reports/burnup-section.tsx:30,33-35,39,58-72`; `hooks/api/build/reports.ts:84,95-102`; `reports-schema.ts:4`. The CSV export writes `sprint_name/start_date/end_date/…` (`reports-export-button.tsx:22-29`). | No cycle burnup/velocity hook exists. | Both ends rename; the CSV column headers are a user-visible break. |
| **Automations and webhooks offer `sprint.started` / `sprint.completed`.** `hooks/api/build/automations.ts:26-27`; `features/build/webhooks/project-webhooks-page.tsx:71-72`. No `cycle.*` trigger exists. | Backend: `src/modules/build/core/dto/automation.schemas.ts:21-22`. | **Do not rename** (§5). The labels stay; only the wiring underneath moves. |
| **Project-create module toggle is named `sprints`.** `features/build/project-create/use-project-create.ts:29,46,75`; `steps/step-toggles.tsx:19,62` (label "Sprints", description "Agile sprint cycles", `syncMod: "sprints"`); contract `hooks/api/build/build-project-schema.ts:60`; backend `src/db/schema/build/core.ts:52` and `projects-provision.service.ts:118,224`. | It is a **persisted JSONB key** inside `projects.settings.modules`. | Renaming it is its own data migration over `build.projects.settings`. **Recommend: do not rename.** Change the user-facing label to "Cycles"; leave the key `sprints`. |

### 7.4 Mechanical frontend changes

- `useSprints` (`hooks/api/build/sprints.ts:27`) → `useCycles`; the whole file is deleted with the
  `SprintsController`, along with its barrel export (`hooks/api/build/index.ts:7`) and
  `types/projects/sprints.ts`.
- `sprintId` in ticket create/update payloads → `cycleId`
  (`types/projects/tasks.ts:159,161,179,182`; senders at
  `features/build/ticket-details/ticket-sidebar.tsx:115` and
  `features/build/views/card-inline-extra-fields.tsx:312`). Note the create form already sends
  `cycleId` only (`features/build/tickets/use-create-ticket-form.ts:295`) — yet still invalidates the
  sprints query key at `:178`, which is dead invalidation today.
- `onBulkSprint` (`features/build/backlog/bulk-action-bar.tsx:56`) → `onBulkCycle`, after the backend
  bulk path learns `cycleId` (§7.3).
- Cache invalidation: `hooks/api/build/ticket-cache.ts:218,280` invalidate
  `buildWorkQueryKeys.projects.sprints(projectId)`; `:241` and `:272` use `changes.sprintId` as a
  trigger for aggregate invalidation. Query keys at `lib/query-keys/build-work.ts:14-19` (sprints)
  and `:50-51` (cycles).
- **Date rendering.** `startDate` / `endDate` arrive as `YYYY-MM-DD` rather than an ISO timestamp
  (§2.3). Any `.split("T")[0]` breaks outright; `new Date(x)` still works. The Zod contracts to
  change are in `hooks/api/build/execution-schema.ts` — `sprintListItemSchema:3-21`,
  `sprintRowSchema:23-34` vs `cycleListItemSchema:37-51`, `cycleRowSchema:54-64`.
- **Status vocabulary.** `PLANNED|ACTIVE|COMPLETED` → `draft|active|completed` (§2.1). Note that
  `execution-schema.ts` already encodes the divergence: sprint `status` is `z.string()`, cycle
  `status` is the 3-value enum at `:44`. Also `lib/theme-constants.ts` exports `sprintStatusColors`
  (consumed at `features/dashboard/sprint-card.tsx:117,124,131`) keyed on the uppercase strings, and
  `types/projects/shared.ts` declares the `SprintStatus` union.
- **Permission keys are unchanged** (§6). `useCan("build:sprints:view")` keeps working everywhere,
  which means the frontend permission layer needs **no coordinated release at all** — the single
  largest risk reduction available in this plan.

### 7.5 Backend deep link

`buildSprintListHref` (`src/modules/build/core/build-app-paths.ts:28-30`) emits
`/build/${projectId}/sprints` — a route the frontend deleted in `9662485c9`. Every
`build.sprint.ending` notification (`build-due-sweep.service.ts:9,170`) and every sprint entity
mention (`build-entity-reads.service.ts:29`) carries a **404 link today**. Rename to
`buildCycleListHref` returning `/build/${projectId}/cycles`, matching
`lib/build/nav/build-project-catalog.ts:76-80` and
`components/layout/command-palette-commands.ts:73,80`. Pinned by
`src/modules/build/core/build-app-paths.spec.ts`, which must change in the same commit.
**This is a live defect, independent of the migration, and should ship in Phase A.**

### 7.6 Frontend gates that will bite

Beyond `check:permission-keys` on the backend side: `pnpm check:permission-catalog`
(`scripts/check-permission-catalog.mjs`), `pnpm check:permission-binding`
(`scripts/check-permission-route-binding.mjs`), and `scripts/check-route-access-contract.mjs`.
All three enforce catalog/route parity and all three fail on a partial permission rename — which is
the fourth independent reason §6 recommends not renaming.

---

## 8. Pre-flight queries

Run these, in order, on the target database **before** 1146. Each has a branch.

```sql
-- P1. Does any project have more than one ACTIVE sprint?
-- If > 0: the backfill will create data updateCycle refuses to create
-- (cycles.service.ts:110-121). This is a product decision, not a migration decision. STOP.
SELECT org_id, project_id, count(*)
FROM "build"."sprints"
WHERE status = 'ACTIVE' AND deleted_at IS NULL
GROUP BY 1, 2 HAVING count(*) > 1;
```

```sql
-- P2. Is (org_id, project_id, name, start_date::date) unique across sprints?
-- If > 0: the CTE join in 1146 pass 2 is ambiguous. Rewrite the loop row-at-a-time. STOP.
SELECT org_id, project_id, name, start_date::date, count(*)
FROM "build"."sprints"
GROUP BY 1, 2, 3, 4 HAVING count(*) > 1;
```

```sql
-- P3. How many sprints land on the org-owner fallback rather than a project manager?
SELECT count(*) FILTER (WHERE p.manager_membership_id IS NULL) AS owner_fallback,
       count(*)                                                AS total
FROM "build"."sprints" s
JOIN "build"."projects" p ON p.org_id = s.org_id AND p.id = s.project_id;
```

```sql
-- P4. Any org with no owner at all? Each such row makes 1146 RAISE.
SELECT DISTINCT s.org_id
FROM "build"."sprints" s
JOIN "build"."projects" p ON p.org_id = s.org_id AND p.id = s.project_id
WHERE p.manager_membership_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM "public"."organization_members" om
                  WHERE om.org_id = s.org_id AND om.is_owner = true);
```

```sql
-- P5. How many tickets carry BOTH, disagreeing? These keep cycle_id; sprint_id is discarded.
SELECT count(*)
FROM "build"."tickets" t
JOIN "build"."sprint_cycle_map" m ON m.org_id = t.org_id AND m.sprint_id = t.sprint_id
WHERE t.sprint_id IS NOT NULL AND t.cycle_id IS NOT NULL AND t.cycle_id <> m.cycle_id;
```

```sql
-- P6. Any sprint status outside the CHECK? The CHECK may never have been VALIDATEd.
SELECT DISTINCT status FROM "build"."sprints"
WHERE status NOT IN ('PLANNED', 'ACTIVE', 'COMPLETED');
```

```sql
-- P7. Batch-size inputs.
SELECT (SELECT count(*) FROM "build"."sprints")                                AS sprints,
       (SELECT count(*) FROM "build"."cycles")                                 AS cycles,
       (SELECT count(*) FROM "build"."tickets" WHERE sprint_id IS NOT NULL)    AS tickets_with_sprint,
       (SELECT count(*) FROM "build"."tickets" WHERE cycle_id  IS NOT NULL)    AS tickets_with_cycle,
       (SELECT count(*) FROM "build_events"."sprint_scope_events")             AS scope_events;
```

```sql
-- P8. Do build.sprints and build.cycles both have RLS enabled and a policy?
-- BE-72: pnpm db:verify-rls is the authority. This is the manual substitute.
SELECT c.relname, c.relrowsecurity,
       (SELECT count(*) FROM pg_policies p
         WHERE p.schemaname = 'build' AND p.tablename = c.relname) AS policies
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'build' AND c.relname IN ('sprints', 'cycles');
```

---

## 9. What is verifiable without a database, and what is not

### Verifiable now (all of these were run or can be run on this worktree)

| check | status on this worktree |
|---|---|
| `pnpm typecheck` | The only gate that sees arity. Catches every signature break across the 55 non-spec files. |
| `pnpm jest src/modules/build/execution --silent` | **Measured: 18 suites / 157 tests, exit 0.** No code was changed by this ticket. |
| `node src/scripts/check-migration-rollback.mjs` | **Measured: exit 0.** Will demand `migrations/rollback/<tag>.down.sql` or `-- @irreversible` for each of 1143–1156. |
| `node src/scripts/check-drop-column-safety.mjs` | **Measured: exit 0** (903 migrations, 134 dropped columns, 413 schema files). Will bite if any Phase-B drop lands without the matching Drizzle deletion. |
| `pnpm check:permission-keys` | Needs the frontend repo reachable, not a database. Proves the §6 recommendation (no catalog change) keeps the gate green. |
| Frontend `check:permission-catalog`, `check:permission-binding`, `check-route-access-contract.mjs` | Catalog/route parity. No database. §7.6. |
| Frontend `pnpm typecheck` + its jest suite | 44 sprint-touching test files. The date-type and status-vocabulary changes (§7.4) are type errors, so typecheck finds most of them. |
| `pnpm check:migration-immutability --emit` | Must be run to seal the new tags into `migrations/meta/_chain.sha256.json`. Not a database operation. |
| Static SQL review | Syntax can be read. It cannot be parsed. |

Also verifiable without a database, and worth writing as specs before any of this ships:
the status-mapping function, the `sprintId ?? cycleId` payload compatibility branch on the consumer,
the dual-write resolution in the three ticket mutation paths, and the `sprintId`-alias resolution in
`projects-work-query.service.ts`. All four are pure functions over inputs and all four are where the
cutover actually breaks.

### **Not** verifiable without a database

- **That any of the SQL above runs at all.** `db:migrate`, `check:migration-chain`,
  `migration:proof*`, `check:migration-ledger`, `db:verify-rls` are all unavailable here (the first
  four carry an env-file flag pointing at production; the credentials are rejected with 28P01).
  Every SQL block in this document is **UNVERIFIED as executable**.
- **Row counts.** Every batch size and every `statement_timeout` judgement in §3 is a guess. P7.
- **RLS and grant parity.** Whether `build.sprints` and `build.cycles` currently carry policies is
  UNVERIFIED (P8). The new `build.sprint_cycle_map` **must** get an explicit policy (BE-74) and
  explicit grants — a table created without grants fails 42501, which reads as an RLS denial and
  sends the investigation to the wrong place.
- **The grantee role name** `streamline_app` used in 1145. Copied from `CLAUDE.md:104`. Confirm
  against the live role set.
- **Whether the CHECK constraint on `sprints.status` was ever validated** (P6). If it was added
  `NOT VALID` and never validated, rows outside the triple can exist and 1146's `CASE` returns NULL
  into a NOT NULL column.
- **Whether any org already runs both sprints and cycles on the same project**, i.e. how much of the
  backfill is `matched_by_name` versus `created`.
- **That the rollbacks roll back.** `pnpm drill:rollback` is the only thing that knows;
  `check:migration-rollback` explicitly never executes one
  (`src/scripts/check-migration-rollback.mjs`, closing note of its report).
- **That a cold replay of the chain still reaches head** after fourteen new entries.

---

## 10. The blocking dependency, exactly

**A non-production PostgreSQL **18** instance with the tenant roles provisioned.**

Not "15+". The floor is 18, and the reason is in the chain itself:

`migrations/0619_chain_creates_what_production_has.sql:3333` (and `:3339`, `:3345`, `:3351`, `:3357`,
and throughout `0620_control_plane_receives_chain_tenant_isolation.sql`,
`0655_chain_creates_remaining_catalog_objects.sql`, `0767b_inv_table_chain_repair.sql`):

```sql
ALTER TABLE "public"."crm_org_party_map"
  ADD CONSTRAINT "crm_org_party_map_organization_id_not_null" NOT NULL organization_id;
```

`ALTER TABLE … ADD CONSTRAINT <name> NOT NULL <column>` — named NOT NULL constraints — is
**PostgreSQL 18 syntax**. It is a syntax error on 17 and below. A cold replay of the chain therefore
dies at 0619 on anything older. Production is Aurora PG18, which is why it has never been noticed.

(A secondary, lower floor exists independently: `ON DELETE SET NULL (<column list>)`, used at
`migrations/1142_fix_requisition_headcount_fk_set_null.sql` and by four of the migrations designed
above, is PG15+. It is subsumed by the PG18 requirement.)

What "provisioned" has to mean, beyond the version:
- extensions `vector`, `pg_trgm`, `btree_gist`, `pgcrypto`, `uuid-ossp` created **before**
  `db:migrate` and never folded into 0000 (BE-67, `CLAUDE.md:92`);
- the `streamline_app` role and whatever `app.current_org_id()` needs, or every RLS policy in the
  chain fails to create;
- enough memory that `check:migration-chain` completes — the chain is 903 journal entries and
  replays roughly 1,105 statements-worth of catalog work.

Everything else in this ticket — the code cutover, the specs, the permission fix, the deep-link fix,
the frontend work — can be written and type-checked today. **Nothing involving the word `migrate`
can be run at all**, and no SQL in this document should be believed until it has been replayed cold.

---

## 11. Effort

Assuming a PG18 instance exists on day one, one engineer, no parallelism.

| work | estimate | notes |
|---|---|---|
| 14 migrations + 13 rollbacks | 2 days | The SQL is written above; the time is in replaying it cold, fixing what breaks, and re-sealing hashes. |
| Pre-flight + backfill rehearsal on a seeded copy | 1 day | P1/P2 have STOP branches that could add unbounded time if they return rows. |
| Backend code cutover | 4 days | 55 non-spec files. ~40 are mechanical `sprintId` → `cycleId`; ~15 carry real logic: velocity report, burnup, due sweep, the completed consumer, dashboard, two AI surfaces, entity reads, bulk mutation, work query, activity, three services, two controllers. |
| Backend specs | 2 days | 46 spec files reference sprints. Several are tenant-isolation specs (`modules-sprints-tenant-isolation.spec.ts`, `epics-cycles-tenant-isolation.spec.ts`, `execution-cross-project-binding.spec.ts`) whose fixtures must be rebuilt, not renamed. |
| Response contracts + OpenAPI | 1 day | `execution-response.schemas.ts`, `build-tickets-response.schemas.ts:29,117,383`, `agent-response.schemas.ts:69,126,185`. Contract drift is the top breakage class in this codebase and it renders as an empty state, not an error. |
| Frontend — mechanical (§7.4) | 5 days | **120 non-test files** (§7.0), of which 63 carry the literal `sprintId`. Most are single-line carry-through in mappers and view types, but the filter machinery (13 files), the API hook/contract/cache layer (24 files) and the board/views cluster (18 files) each need to be reasoned about as a unit. |
| Frontend — URL params (§7.2) | 1.5 days | Three params collapsing to one, across two incompatible conventions, with a single→multi arity widening in the filter bar and a `number` vs `string` type mismatch at `types/projects/tasks.ts:224-225`. |
| Frontend — gap closure (§7.3) | 4 days | **Net-new, not a rename.** Cycle update/delete hooks and UI; `cycleId` on the bulk mutation contract at both ends; meetings moved off `sprintId`; burnup/velocity moved off the sprint axis including the CSV export headers. |
| Frontend tests | 2 days | 44 `*.test.*` files in the sprint set, including route-access parity and nav-model tests that assert the permission key. |
| Permission fix + deep-link fix | 0.5 days | §6 and §7.5. Independently shippable in Phase A. |
| Verification: cold replay, proofs, RLS verify, rollback drill, full suite | 1.5 days | Plus whatever the cold replay surfaces, which is the part that historically runs long. |

**Total ≈ 24.5 working days ≈ 5 calendar weeks**, one engineer, split across three releases with a
retention window between Phase B and Phase C.

This is roughly double what the brief's "~40 frontend files" implied, and the difference is not
padding — it is §7.3. Closing the feature gaps is 4 days of building things that do not exist
(cycle edit/delete, bulk `cycleId`, cycle-aware meetings and reports), and skipping them means the
consolidation ships as a visible feature regression.

Phase A alone is ≈ 4.5 days and is safe to ship on its own, because it is purely additive. Three
items inside it are worth landing **immediately, independently of whether the consolidation ever
proceeds**, because each is a live defect with a small fix:

- the dead `/build/:id/sprints` deep link (§7.5) — 0.5 day;
- the cycle read/write permission split (§6) — 0.25 day;
- the burnup no-writer defect (§0) — separate ticket, not estimated here.

The estimate excludes: the burnup no-writer defect (§0), the `sprint_scope_events` table rename
(§5), any `build:cycles:*` key rename (§6), and renaming the `projects.settings.modules.sprints`
JSONB key (§7.3). All four are deliberately out of scope and should be separate tickets.
