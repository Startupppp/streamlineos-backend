# HR employee export job migration

Status: authored for review; not executed.

This expand-contract bundle supports `COST-060`. It adds the tenant-scoped
`hr_export_jobs` queue used by the existing HR export controller and bounded
worker. It does not activate the worker or make object storage public.

## Preconditions

- Run only on an approved disposable production-size clone first.
- Verify the target database, backup/restore path, migration role, PostgreSQL
  version, `app.current_org_id()` function, and `organizations(id)` FK target.
- Private object storage must be configured and tenant scoped before enabling
  `HR_EXPORT_WORKER_ENABLED`.
- Keep the worker disabled during the additive migration and verification.

## Deploy order

1. Apply `0399_hr_export_jobs.sql` with the bounded statement and lock timeouts.
2. Run `0399_hr_export_jobs.backfill.sql`. It is intentionally data-neutral and
   rejects malformed pre-existing rows.
3. Run `0399_hr_export_jobs.verify.sql`; require a zero-error result for the
   exact table, constraints, indexes, forced RLS, and tenant policy.
4. Deploy the compatible API with the export worker still disabled.
5. Verify create/status/download authorization, tenant isolation, audit events,
   private signed downloads, retry limits, and expiry cleanup on the clone.
6. Enable one worker canary only after private storage readiness is observed.
7. Repeat the same hash-bound procedure in production only after separate
   target-specific execution approval.

## Rollback

`0399_hr_export_jobs.down.sql` drops only the new table and refuses to proceed
when any job row exists. Disable the worker and API creation path first. If rows
exist, retain the additive table until artifacts expire or an explicitly
approved archival plan reconciles them; do not delete job history merely to
make rollback pass.

No database, migration, backfill, or worker activation was performed from this
worktree.
