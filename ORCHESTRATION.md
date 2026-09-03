
## The sweep that turns a recoverable orphan into an unrecoverable one — 2026-09-03

Three findings compose into one defect, and the composition is worse than any part:

1. `StorageService` carried `bucketOverride` on every UPLOAD path and on **no read or delete path**.
   Now fixed across `deleteFile`, `deleteFileIfPresent`, `getFileUrl`, `fileExists`,
   `describeObject`, `readObjectPrefix` and `getFileStream`.
2. An S3-compatible delete of a nonexistent key **returns success**, so a delete aimed at the wrong
   bucket is indistinguishable from a real one. This is why it never surfaced as an error.
3. `cron-storage-sweep.service.ts:95` drains `storage_pending_purge` — including
   `purpose="kb:page:purge"` rows — and then calls `markConfirmed(row.id)`. So it **deletes the
   write-ahead pointer after a delete that addressed the wrong bucket.**

Together: the write-ahead row exists precisely so a failed delete stays findable. Point the delete
at the wrong bucket, get a success back, and the sweep then destroys the only record that the
object was ever pending. **A recoverable orphan becomes an unrecoverable one, and the system
reports success at every step.** Fixing (1) alone does not fix this; the bucket must be carried on
the row or derived from `purpose`, and `APP_CONFIG` injected into the sweep.

**Honest severity, as the agent stated it:** *latent in this checkout*, because
`R2_KB_BUCKET_NAME` is absent from `.env` here so both sides fall through to the default bucket and
agree by accident. It is a first-class config surface (`env.validation.ts:161`,
`region.config.ts:237`, `setup-r2-buckets.ts`), so it goes live the moment anyone sets it. That is
a deployment-shaped bug, not a code-shaped one — it will appear in the environment that separates
the buckets, which is production.

Four kb call sites still pass no bucket and are named in report 44. None is a one-line change:
each either breaks a spec's `toHaveBeenCalledWith` arity or needs `AppConfig` injected.

`check:tenant-isolation` went **929/930 exit 1 → 930/930 exit 0**, with a behavioural (not
declarative) spec: a foreign tenant's backlog returns an EMPTY LIST, never an error — 404-shape,
never 403. Bite-proved hermetically: deleting the `orgId` predicate turns 7 of 8 red, and
`markConfirmed`/`markFailed` both bite, because org B's row id reached a destructive update.

The composite-FK-NULL rule does NOT apply to this table and the agent checked rather than assumed:
`migrations/0741` declares `org_id text NOT NULL` with no FK at all (deliberate, documented) and
RLS `USING (org_id = app.current_org_id())`.

## Eighth attribution incident — a bulk rewrite of `.scratch/`

The frontend `.scratch/` tree was bulk-rewritten and destroyed one agent's report and ticket note
outright; it rewrote both. A partial commit is refused mid-merge, so the rewrite then landed inside
another agent's merge commit. Content is correct in HEAD; attribution is not. Combined with the
seventh incident, the lesson is the same one twice: **anything that rewrites or merges a shared
tree is orchestrator-only**, because it silently destroys work no pathspec discipline can protect.
