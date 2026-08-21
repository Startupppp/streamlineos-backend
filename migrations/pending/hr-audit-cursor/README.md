# HR audit cursor index

Status: authored for review; not executed.

This additive bundle closes the local portion of `COST-005`. It supports the
tenant-scoped descending `(created_at, id)` keyset used by
`GET /hr/audit-logs` and removes the endpoint's offset/count query path.

Apply and rollback the index files outside a transaction because PostgreSQL
`CREATE/DROP INDEX CONCURRENTLY` cannot run inside a transaction. Use an
approved disposable production-size clone first, retain the five-second lock
timeout, monitor invalid-index state, then run the data-neutral backfill guard
and exact verifier. Deploy the cursor-compatible API after the verified index.

The older single-column indexes are retained until production-size
`pg_stat_user_indexes` evidence proves one is redundant. No database command
was executed from this worktree.
