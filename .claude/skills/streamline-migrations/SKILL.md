---
name: streamline-migrations
description: |
  Author, number, journal and PROVE a StreamlineOS database migration. Use this
  whenever you add, rename, renumber or review a `.sql` file under
  `migrations/`, touch `migrations/meta/_journal.json`, hit a duplicate
  migration number after merging, see "column does not exist" on a cold build,
  or are about to claim a migration works. Also use it when a merge conflicts
  on the journal, when `db:migrate` reports success but nothing changed, or
  when adding a composite foreign key, a CHECK constraint, an RLS policy, or a
  new permission key. Four separate things here fail SILENTLY — an unjournalled
  file, a stale watermark, a bare composite SET NULL, and a permission backfill
  — so reach for this even when the change looks like one line.
---

# StreamlineOS migrations

Migrations here are hand-authored (`db:generate` is unusable on this schema,
BE-57) and four of the failure modes are silent: they report success. That is
why this skill exists — not because the SQL is hard.

## 1. Number AFTER `origin/main`'s highest, at the last moment

Parallel lanes claim the same number constantly. On 2026-09-24 two lanes both
took 1122–1130; on 2026-09-25 two lanes both took 1185 and 1186. Both times the
collision surfaced as a journal merge conflict, not as anything at authoring
time.

```bash
git fetch origin main --quiet
ls migrations/*.sql | sed 's|.*/||' | cut -d_ -f1 | sort -n | tail -1
git show origin/main:migrations/meta/_journal.json | python3 -c \
  "import json,sys; print(json.load(sys.stdin)['entries'][-1])"
```

Take the higher of the two and add one. If you are merging and both sides used
a number, **main keeps it** and yours move up — main's is already on origin and
yours has never been applied anywhere.

## 2. Renumbering is free before it is applied, and only before

The runner keys a migration on the **content SHA-256** of the file, not its
tag. So renaming `1185_foo.sql` → `1187_foo.sql` is invisible to a database
that already applied it. Editing the file — including its header comment — is
not: that is a new hash, and the runner will try to run it again.

Practically: renumber and fix the `-- NNNN —` header freely while the migration
has only ever run inside a rolled-back transaction. Once it has been applied to
a real database, neither the content nor the comment may change (BE-60).

## 3. Shift references in ONE pass

Source refers to migrations by number, and some of it refers to them by
**path**. `disposition/rejection-reasons.spec.ts` reads its own migration off
disk to prove the catalog in the module, the CHECK constraint and the Drizzle
`$type` union cannot drift apart — under a stale name it throws ENOENT.

Renumbering 1185→1187 and 1187→1189 in separate passes re-shifts the first to
1189. Do it as one regex pass with a lookup:

```python
SHIFT = {"1185":"1187", "1186":"1188", "1187":"1189", "1188":"1190"}
pat = re.compile(r"(migration )(118[5-8])|(migrations/)(118[5-8])(_[a-z_]+\.sql)")
# one subn() per file, never a chain of str.replace
```

Then confirm nothing stale survives:
`grep -rn "migration 118[5-6]\|migrations/118[5-6]_" src/`

## 4. Journal it, or it never runs

An unregistered `.sql` never executes and `db:migrate` still prints success
(BE-58). 27 files were orphaned this way once.

- `idx` unique, `when` strictly increasing (BE-59)
- Append; never renumber an existing entry to close a gap
- Array order IS apply order — keep it numeric so a human can read it
- **Position 342 on `origin/main` has a non-increasing `when`.** It is
  pre-existing. Do not "fix" it; just exclude it when you assert the invariant.

```python
idx=[e["idx"] for e in entries]; when=[e["when"] for e in entries]
assert len(set(idx))==len(idx)
print([i for i in range(1,len(when)) if when[i]<=when[i-1]])  # expect [342]
```

## 5. Prove it by replay — declared is not applied

A constraint that exists in the file is not a constraint that works. Run
`scripts/replay-migration.py`, which applies your migrations inside a
transaction it then rolls back, and lets you fire real INSERTs at them.

```bash
python3 .claude/skills/streamline-migrations/scripts/replay-migration.py \
  1187_rejection_reason --db streamline_test > /tmp/replay.sql
psql -d streamline_test -v ON_ERROR_STOP=0 -f /tmp/replay.sql
```

It sets `session_replication_role = replica`, which disables FK triggers so you
can insert a bare row — CHECK constraints still fire, which is the point. Write
a case for each branch and say what you expect:

- a value the catalog allows → `INSERT 0 1`
- a value outside it → `ERROR`
- the conditional case (`OTHER` with a blank note) → `ERROR`
- the historical case (all-null) → `INSERT 0 1`, because existing rows must survive

Read back what landed, rather than trusting the DDL:

```sql
SELECT conname, convalidated FROM pg_constraint WHERE conrelid='t'::regclass;
SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname='t';
SELECT polname, polcmd FROM pg_policy WHERE polrelid='t'::regclass;
```

## 6. Composite FK `SET NULL` needs a column list

`(org_id, x)` referencing `(org_id, id)` with a bare `ON DELETE SET NULL` nulls
**`org_id` too**, which violates the NOT NULL tenant column and aborts the
parent delete. Name the column:

```sql
ON DELETE SET NULL ("job_level_id")
```

Verify with `pg_get_constraintdef` — `confdelsetcols` is the underlying field.

## 7. Never backfill permissions

`RoleGrantReconcilerService` delivers permission grants at boot (BE-111). A
migration that inserts them violates the FK until catalog sync runs. Widen the
role template instead. A new key must land in the **backend and frontend
catalogs together** or `useCan` is false forever (BE-112).

Withdrawing a scopable key is the mirror image: the catalog edit alone is
inert, because supported-scope rows are never deleted — that one does need a
migration.

## 8. Standing constraints

- **HR table count is frozen.** A new table must not be `hr_*`-prefixed.
- Additive shape: nullable → backfill in batches → NOT NULL (BE-61), one
  purpose per migration.
- `SET lock_timeout = '5s'` at the top so it fails fast instead of queueing
  behind the table (BE-64).
- `NOT VALID` on CHECKs and FKs where existing rows cannot violate them — it
  binds new rows while skipping the table scan.
- Ship a rollback for anything destructive (BE-71). Four rollback files
  deliberately do **not** exist; 47/51 is correct, not a gap.

## 9. When `db:migrate` lies

On Neon the watermark can sit ahead of the journal and silently skip
migrations — it skipped 32 once. The runner has been fixed, but when a column
is missing in an environment that reports "migrated", check the ledger against
the journal before re-running anything, and probe inside
`sql.begin("read only")`.

A repo-wide e2e failure, or a screen that renders "Failed to load" as an empty
state, is usually column drift rather than your feature.
