---
name: streamline-security-review
description: |
  Security review for StreamlineOS — route exposure, tenant isolation, RLS,
  audit integrity, tokens, idempotency, and honest failure states. Use when
  reviewing or writing anything that adds a route, reads or writes a
  tenant-scoped table, touches permissions or RBAC, handles a token or webhook,
  runs in a cron or background sweep, deletes or erases personal data, or
  reports a provider result. Also use when asked whether a change is safe to
  ship, or for a security pass on a branch. The dangerous defects in this
  codebase are not injection — they are a route nothing gates, a guard that
  stops holding outside a request, and a success message for something that did
  not happen.
---

# Security review — StreamlineOS

Drizzle parameterizes by construction and there is no password login, so the
classic injection/credential checklist is largely inapplicable. The real attack
surface is authorization, tenancy, and honesty.

## 1. Exposure — the decorator alone gates nothing

Every route declares **exactly one** of `@Public()`, `@Universal()`,
`@RequirePermission(...)`, `@AuthorizedInService("<what checks it>")`. Absence
denies at boot (BE-30).

**`PermissionGuard` is NOT global** (BE-29). A route carrying
`@RequirePermission` but not `@UseGuards(JwtAuthGuard, PermissionGuard)` is
authenticated and completely unchecked. This is the highest-value thing to look
for — it reads as gated.

To make a route universal, move the guard; never delete the key (BE-31).
`check:route-classification` enforces declaration, not correctness of choice —
read what `@AuthorizedInService` claims and verify that check exists.

## 2. Tenancy — a guard that only holds inside a request

Cross-tenant miss is **404, never 403** (BE-91): a 403 confirms the record
exists, turning an id probe into a directory of another tenant's data.

Re-assert `org_id` in the query itself, on the table and on every join. Leaning
on `ensureX()` plus RLS is fine inside a request and stops holding the moment
the code runs from a cron, a sweep or a test harness, because there is no
tenant GUC there. Background work iterates with `forEachOrg` (BE-87).

- `runInTenantTransaction` / `runInNewTenantTransaction` set the GUC;
  `app.current_org_id()` fails closed with `42501` when it is absent.
- **FORCE RLS filters the owner too** — a migration running as owner against
  `external_effect_ledger` sees zero rows and silently does nothing.
- Never use an unprojected relation to global `users` (BE-46) — those rows hold
  authentication secrets.
- Reject client-sent `orgId`, `role`, `isAdmin`; identity comes from
  `@CurrentUser()` (BE-32, BE-92).

Assert the **SQL the service builds**, not a stubbed return value. A double
that hands back the right rows proves the mapping and nothing about the
predicate — and the predicate is the entire feature.

## 3. Side effects and audit integrity

- A fire-and-forget call must not borrow the request transaction (BE-82). After
  commit its queries hang or die `42501`.
- `logCritical` rides the request transaction, so **an audit row written before
  a throw rolls back with it**. Before throwing, use
  `logCriticalOutsideTransaction` — otherwise the refusal you are auditing
  leaves no trace.
- Store an erasure record where the erasure cannot destroy it: `audit_logs`,
  not a table that cascades on the deleted row.
- An emit with no registered consumer dead-letters; it does not no-op.

## 4. Tokens, idempotency, RBAC

- Agent tokens need `@AllowAgentToken()`; `APP_GUARD`s run first.
- **Scoped tokens get everything unless you call `authorize()`** —
  `resolveUserPermissions` is principal-blind.
- Two idempotency mechanisms are live: `@IdempotencyKey()` and `@Idempotent()`
  (the latter 400s without the header). The browser api-client mints a key per
  fetch, so it provides **no replay protection** — use `useIdempotentMutation`.
- Never delegate the `billing:` namespace, including the owner's own (BE-110).
- Permission keys land in the backend and frontend catalogs together or
  `useCan` is false forever (BE-112). Never backfill grants by migration
  (BE-111).
- `<module>:access:manage` is view-only; it never creates management authority
  (BE-116).

## 5. Honest states — the defect class that ships most often

A success message for something that did not happen is a security defect here,
not a UX one.

- A provider you cannot call ships as an explicit blocked state with a reason —
  never `PUBLISHED`, `SYNC_INITIATED`, `CLEARED` or `Verified`. Every provider
  family ships an **empty adapter registry**, asserted by a test per family.
- Distinguish "we could not check" from "they failed". `UNAVAILABLE` and
  `FAILED` mean different things; a shared label turns a missing integration
  into an accusation.
- **A 204 cannot describe a partial outcome.** The candidate delete returned
  204 while hard-deleting the person and leaving their résumé in the bucket
  with nothing pointing at it — unreachable by any later erasure request. If an
  operation can partially fail, the response must be able to say so; an
  S3-compatible delete of an absent key answers success either way.
- Never relay an unconfirmed erasure to a data subject as "deleted".

## 6. Reading errors

`err.code === "23505"` is dead — Drizzle wraps driver errors, and postgres-js
spells it `constraint_name`. Use `isUniqueViolation` from
`common/db/postgres-error`, and catch it as a 409 rather than a 500 (BE-41).

An `APP_FILTER` never wins over the catch-all; extend `HttpException` instead.

## Before signing off

Run `check:route-classification`, `check:record-access`,
`check:scope-boundary`, `check:permission-keys` and `check:module-di`, and
attribute any red per `streamline-code-review` before calling it a regression.
Test authorization with two accounts in two orgs — 404 cross-tenant, 403
in-tenant. Say plainly what you did not exercise.
