# HRMS relational normalization review bundle

Status: review-only. These files are not in the Drizzle journal, have not been
run against any database, and do not authorize a production mutation.

## SCH-006 evidence

The source audit used exact symbol and table searches before authoring the
bundle:

```text
rg -n "disciplinaryRecords|grievanceRecords" backend/src
rg -n "onboardingTasks|dependsOnTaskIds" backend/src
rg -n "documents.tags|tags: input.tags|input.tags !== undefined" backend/src/modules/hr
rg -n "terminations.reasons|reasons: input.reasons|supportingDocUrls" backend/src/modules/hr
rg -n "insert\(documents\)|update\(documents\)" backend/src
rg -n "insert\(terminations\)|update\(terminations\)" backend/src
```

Confirmed paths:

- `hr_employee_sensitive_fields.disciplinary_records` and
  `grievance_records` are declared at
  `backend/src/db/schema/hr/core-people.ts:247-248`. No application writer was
  found. `HrSensitiveService` reads the entire sensitive row and therefore
  exposes both legacy values; its compatibility projection is at
  `backend/src/modules/hr/core/hr-sensitive.service.ts:219-234`.
- `onboarding_tasks.depends_on_task_ids` is declared at
  `backend/src/db/schema/hr/onboarding.ts:59`. No application writer was
  found. `OnboardingTaskService` returns `getTableColumns(onboardingTasks)` at
  `backend/src/modules/hr/onboarding/core/onboarding-task.service.ts:139` and
  reconciles dependencies at lines 153-168.
- `documents.tags` has active list/search/category reads and create/update
  writes in `backend/src/modules/hr/performance/documents.service.ts:35-46`,
  `:70`, `:103`, `:132-143`, `:233-246`, and `:309-325`. Other document
  inserts use the legacy default empty list and do not write tags.
- `terminations.reasons` has active list, create, detail, completion, letter and
  email paths in `backend/src/modules/hr/lifecycle/termination.service.ts:67`,
  `:110-124`, `:223-247`, `:274-294`, `:426-436`, and
  `termination-communications.service.ts:182-193`.
- `terminations.supporting_doc_urls` is declared at
  `backend/src/db/schema/hr/offboarding.ts:152`. No application writer was
  found. The detail contract reads it through the Drizzle relation and resolves
  a reconciled child projection in `termination.service.ts:274-294`.

The existing `hr_disciplinary_actions` table is not a safe migration target for
the disciplinary JSON. Its required action type, employee, issuer and effective
date cannot be recovered reliably from an unknown payload. Each legacy JSON
object is therefore isolated as one durable child record. The canonical cases
and disciplinary workflow remains independent.

## Files and order

1. `0000_hrms_relational_normalization.sql` creates six additive tenant-scoped
   relations, stages and validates all foreign keys, adds order/value/self-link
   constraints and indexes, enables tenant RLS, and grants the configured
   application role access.
2. `0001_hrms_relational_normalization_backfill.sql` performs an idempotent,
   order-preserving UTC backfill. Duplicate or invalid legacy values are not
   hidden: uniqueness keeps the normalized relation valid and `verify.sql`
   refuses reconciliation until the legacy source is remediated.
3. `verify.sql` fails on missing relations, missing RLS, unvalidated foreign
   keys, malformed sensitive JSON or any ordered legacy/normalized mismatch.
4. `0000_hrms_relational_normalization.down.sql` refuses rollback when the
   child data differs from the retained legacy columns, then drops only the six
   additive relations.

The application checks `to_regclass` before touching an additive relation, so
the same build remains compatible before and after the forward migration.
Document tags and termination reasons are written to the legacy column and
child rows through the same tenant transaction. Reads use child rows only when
their ordered values exactly match the retained legacy contract; otherwise
they fall back to the legacy value. Null legacy values remain null.

## Supporting-document boundary

`termination_supporting_documents.legacy_url` is compatibility metadata only.
This bundle deliberately does not add a bucket, object key, public URL or
storage provider model. Removing `supporting_doc_urls` requires a separately
reviewed private object reference, tenant-scoped short-lived signed download
service, access audit, retention policy, key custody and completed URL-to-object
reconciliation.

## External execution gates

Before any database execution, all of the following remain required:

1. Restore a production-size point-in-time copy into a separately identified
   disposable clone.
2. Bind forward, backfill, verification and rollback hashes to that clone and
   to the exact database, server identity, execution role, application role,
   approval and expiry.
3. Prove `app.current_org_id()` and the non-`BYPASSRLS` application role are the
   intended targets; capture table, index, row-count and lock baselines.
4. Rehearse forward plus backfill, run `verify.sql` to zero mismatches, validate
   RLS with missing/correct/cross-tenant GUC tests, and capture query plans for
   the child lookups.
5. Rehearse rollback, refusal under injected drift, reapply, resume and full
   clone restore.
6. Deploy the compatibility build, canary dual writes and measure mismatch and
   error telemetry before selecting normalized reads as authority.
7. Obtain a separate production target-bound approval. Legacy column removal
   is a later contract migration and is not part of this bundle.

No production or clone database command was run while authoring this bundle.
