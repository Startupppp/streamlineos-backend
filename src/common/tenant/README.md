# Tenant context (RLS)

Every request runs inside a transaction that carries its tenant id in a Postgres
GUC, and RLS policies compare `org_id` against it. This directory is the app-side
half; the policies live in `migrations/`.

## Setting up a new environment

Three commands, in order, from `backend/`:

```bash
pnpm db:bootstrap        # extensions, then every migration (policies included)
pnpm db:bootstrap-role   # the non-owner app role, its grants, default privileges
pnpm db:verify-rls       # proves isolation against this database
```

Then set the app role's password (most providers only allow this from their
console) and point `APP_DATABASE_URL` at it. `DATABASE_URL` stays the owner so
migrations keep working. Unsetting `APP_DATABASE_URL` rolls RLS back instantly.

Relevant env vars: `APP_DB_ROLE` (default `streamline_app`), `APP_DB_PASSWORD`,
`APP_DB_SCHEMA` (default `public`), `DIRECT_DATABASE_URL` (a session-mode
connection; only Neon can be derived automatically).

Nothing here hardcodes a provider. `db:bootstrap-role` refuses to rewrite
provider-managed roles (`postgres`, `authenticated`, `service_role`,
`neondb_owner`, …), repairs only what is actually wrong, and prints the exact
statements an operator must run when it lacks the privilege itself.

## Why the app must not connect as the owner

`BYPASSRLS` is checked before table ownership, so a role holding it ignores
policies no matter what. The database owner typically has it — verified here:
`neondb_owner` has `rolbypassrls = true`. The boundary is therefore the *role the
app connects as*, not `FORCE ROW LEVEL SECURITY`. FORCE only subjects the owner
to its own policies and is unnecessary while the migration role keeps `BYPASSRLS`.

## The pooler constraint

Connections go through a transaction-mode pooler: a server connection returns to
the pool at COMMIT and is handed to the next caller, who may be a different
tenant. `withTenant` therefore uses `set_config('app.organization_id', $1, true)`
— the third argument is `is_local`, which makes it behave like `SET LOCAL` and
revert at COMMIT/ROLLBACK. **A plain `SET` would leak one tenant's id to the next
borrower.** That is the one rule that must never be broken; `db:verify-rls`
asserts it.

## Policies call `app.current_org_id()`, never `current_setting` directly

Two things about `current_setting` make the direct call wrong here.

**It does not reliably raise when unset.** Once a custom parameter has been set
even once in a session it stays *known* to that session and afterwards reads as
the empty string. So `current_setting('app.organization_id')` without `missing_ok`
raises only on a connection that has never served a request; every connection
after its first would compare `org_id` against `''`, match nothing, and deny
silently. Safe, but a route that lost its tenant context would look like an empty
table rather than a bug.

**A restrictive-only policy denies everything.** Postgres shows a row only if some
*permissive* policy allows it; `AS RESTRICTIVE` can subtract but never grant. One
permissive policy per table is the isolation rule.

So the shape is:

```sql
ALTER TABLE <table> ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON <table>
  FOR ALL
  USING      (org_id = app.current_org_id())
  WITH CHECK (org_id = app.current_org_id());
```

`app.current_org_id()` (migration `0374`) raises `42501` when there is no tenant
context, so a gap fails loudly. If a silent deny is ever preferred in production,
`CREATE OR REPLACE` that one function to return NULL — no policy changes.

The function is `STABLE`, which is load-bearing rather than decorative: Postgres
evaluates a stable zero-argument function once per query and folds the result
into the plan, so the policy stays sargable. Measured on 200k rows across 500
tenants with a leading-`org_id` index: `Index Cond: (org_id = app.current_org_id())`,
bitmap index scan, 400 rows in 0.58 ms, no per-row function call. Marking it
`VOLATILE` would evaluate it per row and force sequential scans.

## How a query gets its tenant

`TenantContextInterceptor` (global) opens `withTenant` for any request carrying
`req.user.orgId` or `req.portalUser.organizationId`, and stores the transaction in
`AsyncLocalStorage`. `createTenantAwareDb` proxies the injected `DRIZZLE` provider
so `this.db.select()` resolves to that transaction — which matters because 557 of
767 service files never open a transaction and would otherwise issue autocommit
statements with no GUC.

Requests with no org (auth, health, public routes) open no transaction; the tables
they touch have no tenant column and no policy.

`@NoTenantTransaction()` opts a handler out. Required for SSE and anything that
stays open long enough to pin a pooled connection — such a handler must wrap its
own database work in `runInTenantTransaction(db, fn, { orgId })`.

Background sweeps pass an explicit `orgId` per organization.
`runInTenantTransaction` refuses to open one tenant's transaction inside another's,
because a `SET LOCAL` made in a subtransaction survives its release and would leak
the wrong tenant into the remainder of the outer transaction.

## Rollout order

1. **App role + grants** — `pnpm db:bootstrap-role`. Done for this database:
   767/767 tables granted, `bypassrls=false`.
2. **Plumbing** — proxy + interceptor. Verify in staging *before* policies exist by
   asserting `current_setting('app.organization_id')` matches the caller.
3. **Canary** — `projects` (migration `0375`). Verify as the app role while the
   app still connects as the owner, so nothing depends on it yet.
4. **Policies** — migrations `0376` (payroll/PII), `0377` (financial), `0378`
   (everything remaining). Done: **740 of 740** tenant-scoped tables carry
   `tenant_isolation`, with zero gaps. All inert until step 5.
5. **Switch** — set `APP_DATABASE_URL`. This is the step that turns every policy
   on at once, so do it in staging first. Rollback is unsetting the variable.

## Choosing a mechanism for side effects

Every side effect that reaches the database outside the request transaction must answer one question: **does the work need a connection, and must it happen if and only if the transaction commits?**

| Need | Mechanism | Rule |
|---|---|---|
| Caller needs the result before returning | Inline, with a timeout | Blob uploads, presigned-URL generation, third-party calls that produce a field in the response — put them inline **only** when the caller genuinely cannot proceed without the result. Set `requestTimeout` on the provider client. |
| Work must succeed if and only if the transaction commits | Outbox | Write the intent row inside the current transaction; a cron-guarded relay retries. Use for notifications, emails, webhooks — any side effect that must not be lost on process restart. `NotificationDispatchService.emit()` follows this pattern. |
| Work is advisory — a failure leaves the primary record intact | `registerAfterCommit` + `runInNewTenantTransaction` | Deferred hooks run once the request's transaction has committed. They **must** open their own tenant context via `runInNewTenantTransaction` before any write, because the request's GUC is gone at that point. The interceptor logs and routes failures through `reportError`. Use for blob uploads where the primary row is the real artefact (e.g. CSV export for a payroll batch). |
| Recurrent background sweep | `forEachOrg` + `runInNewTenantTransaction` per org | No ambient context exists. Pass the orgId explicitly. Never rely on an inherited GUC. |

**The mistake this rule prevents:** uploading a file or sending a request *inside* the `withTenant` transaction holds the pooled connection for the full I/O duration, because Neon's transaction-mode pooler ties the server connection to the transaction. Move anything that is not a database write outside it.

**The 42501 rule:** any `this.db` call made from an after-commit hook, a background sweep, or any code that runs after `withTenant` returns, reaches the pool with no tenant GUC and is denied by RLS. The only fix is `runInNewTenantTransaction` — not a cast, not a direct pool query, not a bare `transaction()`.

## Tables that need a different policy

- **8 tables have a nullable `org_id` holding genuinely global rows** —
  `notification_events` (all rows), `payroll_templates` (all),
  `payroll_statutory_rule_sets` (all), `login_history`, `guided_tours`,
  `audit_logs`, `coupons`, `platform_payments`, plus
  `email_outbox.organization_id`. A plain policy would hide these and break
  payroll and notifications. They need
  `USING (org_id IS NULL OR org_id = app.current_org_id())` with
  `WITH CHECK (org_id = app.current_org_id())`, so global rows stay readable but a
  tenant cannot write one.
- **12 tables name the column `organization_id`** — `business_parties`,
  `command_fences`, `email_outbox`, `inbox_records`, `organization_people`,
  `outbox_events`, `party_contacts`, `portal_invitations`, `portal_memberships`,
  `project_client_grants`, `worker_engagements`, `workers`.
- **`contacts` has both.** Its `org_id` is the live `text NOT NULL` column;
  `organization_id` is a dead nullable integer and should be dropped.
- **27 tables have no tenant column** — including `users`, `sessions`,
  `user_sessions`, `devices`, `accounts`. RLS cannot reach them; they stay
  protected by application logic alone.
