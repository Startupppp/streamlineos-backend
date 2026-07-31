# Tenant context (RLS plumbing)

This is **Phase 1 of the RLS rollout, and it is deliberately inert.** Nothing in
the request path uses it yet and **no Postgres policy exists**. It is here so the
GUC mechanism can be reviewed and tested before anything depends on it.

The previous version of this directory was deleted precisely because it shipped
ahead of its policies: it had zero consumers while an interceptor wrapped every
HTTP request in an `AsyncLocalStorage` frame for no benefit. **Do not register
an interceptor until the phase order below is followed.**

## Why RLS does nothing today

The application connects as **`neondb_owner`**, which **owns every table**. A
table owner bypasses row-level security unless the table carries
`FORCE ROW LEVEL SECURITY`. So a policy written today is a no-op — the first
real step is a non-owner application role, not a policy.

## The pooler constraint

Connections go through Neon's **transaction-mode pooler**. A server connection is
returned to the pool the moment a transaction ends and handed to the next caller,
who may belong to a different organization.

`withTenant` therefore uses `set_config('app.organization_id', $1, true)`. The
third argument is `is_local` — it makes the setting behave like `SET LOCAL` and
die at COMMIT/ROLLBACK. **A plain `SET` would leak one tenant's GUC to the next
borrower of that connection.** That is the one rule that must never be broken.

## The hard part: single-statement queries

Most service code calls `this.db.select()` directly, outside any transaction.
An autocommit statement cannot carry a GUC, and wrapping the request handler in a
transaction does not help either, because services inject the singleton `db`, not
the `tx`. Measured: **556 of 766 service files never open a transaction**, across
roughly 1,880 single-statement calls, plus 8 background workers that run with no
HTTP request at all.

The workable design is a Proxy over the `DRIZZLE` provider that routes to the
AsyncLocalStorage-held transaction when one is in flight and falls through to the
pool otherwise — no changes to the 766 service files. `runInTenantTransaction`
already implements the "reuse the ambient transaction" half and fails closed when
there is none.

## Phase order — do not reorder

1. **Create a non-owner app role** (`streamlineos_app`) with DML grants but no
   ownership and no `BYPASSRLS`. Keep `neondb_owner` for migrations. *Operator
   step; not a Drizzle migration.*
2. **Plumbing** (this directory) + the DRIZZLE proxy + an `APP_INTERCEPTOR`.
   Verify in staging while **no policy exists** — assert
   `current_setting('app.organization_id', true)` matches the caller.
   Background workers must pass an explicit `orgId`.
3. **One canary table.** `ENABLE ROW LEVEL SECURITY` (not FORCE) so the owner
   still bypasses and the running app is unaffected. Verify as the app role.
4. **Switch the app to the new role** via a separate env var so unsetting it
   rolls back instantly.
5. **Expand by risk**: payroll/PII, then financial, then core business, then the
   rest of the ~672 tables with a tenant column.
6. **`FORCE ROW LEVEL SECURITY`** last, once migrations/ops have their own path.

Rollback at every phase is one statement or one env var.

## Policy shape

```sql
CREATE POLICY tenant_isolation ON <table>
  AS RESTRICTIVE
  USING (org_id = current_setting('app.organization_id'));
```

Use `current_setting('app.organization_id')` **without** the missing-ok second
argument, so an absent GUC raises rather than silently matching nothing. And
never add an `OR current_setting(...) = ''` escape hatch — that is fail-open.

Note the 12 tables that name the column `organization_id` rather than `org_id`;
they need the same policy against that column.
