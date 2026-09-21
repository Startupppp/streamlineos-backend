# backend/CLAUDE.md — StreamlineOS API

NestJS 11.1 · TypeScript 5.6 strict · Drizzle 0.45 + postgres-js on Neon · Redis · Zod 4 · Node ≥22 · pnpm 10.18.
This repo owns all business logic, APIs and schema. Root `CLAUDE.md` holds the cardinal rules and precedence; this file wins on backend matters.

Cite rules by ID in review (`BE-14`). `(gate: x)` names the `pnpm` check that fails the PR — run it before claiming done; run its `:self-test` sibling first, because a gate that resolves nothing reports zero vacuously. A rule with no gate is enforced in review only.
**BE-19…BE-27 are the cross-repo contract.** `frontend/CLAUDE.md` cites those IDs and must never restate them.

## 1. Modules & Layering

**BE-01.** Register every module in `src/app.module.ts`. *Why:* unregistered code compiles green and does not exist. (gate: check:module-registration)
**BE-02.** Nest sub-modules inside the parent — `modules/build/qa/`, never `modules/build-qa/`.
**BE-03.** Put a parent module's own controllers and services in `<module>/core/`.
**BE-04.** Reach another module through its service, never its repository, schema or tables.
**BE-05.** There is no repository layer — one file exists repo-wide. Controller → service → Drizzle. Do not add a second pattern.
**BE-06.** Keep DB access out of controllers. 42 still hold `this.db`; that count may only shrink.
**BE-07.** Return explicit projections, never raw ORM rows. (gate: check:query-projections)
**BE-08.** Name every file and folder kebab-case. (gate: check:kebab-case)
**BE-09.** Keep source files under 500 lines; 300+ is ratcheted. (gate: check:file-sizes, check:over-300)
**BE-10.** Keep the import graph acyclic; never hide a cycle behind `forwardRef`. (gate: check:cycles)
**BE-11.** Never `import type` an injected Nest service. *Why:* it erases the DI token and boots null.

## 2. Validation & Contracts

**BE-12.** Validate every body, query and param with `@Validate({...})`. *Why:* `class-validator` is not installed.
**BE-13.** Use `z.object().strict()`. Unknown keys are rejected, not stripped.
**BE-14.** Declare every route param in the `.strict()` params schema. *Why:* one missing param 400s every call. (gate: check:params-schema-completeness)
**BE-15.** Type payloads with `z.infer`, never a hand-written parallel interface.
**BE-16.** Keep schemas in the module's `dto/`, never inline in a controller.
**BE-17.** Never catch or reshape a `ZodError`; `AllExceptionsFilter` maps it to 400.
**BE-18.** Declare `@ResponseSchema(...)` on every handler. (gate: check:openapi-coverage, check:contract-registry)

## 3. Cross-Repo Contract — frontend cites these IDs

**BE-19.** Success envelope is `{ success: true, data }`; a payload already carrying `success` passes through unchanged. (`common/interceptors/response-transform.interceptor.ts:9`)
**BE-20.** Error envelope is `{ code, message, details?, correlationId? }`. (`common/http/all-exceptions.filter.ts:10`)
**BE-21.** `204` returns no body.
**BE-22.** Status semantics: **402** module/plan/credit · **403** in-tenant permission denial · **404** cross-tenant miss · **409** conflict · **429** rate limit with `Retry-After`.
**BE-23.** Module denial throws `ModuleDisabledException` — 402, `code: "MODULE_NOT_ENABLED"`, `details: { moduleKey, reason, upgradePath }`.
**BE-24.** Cap every list at 100 rows per page, public included. Import `PAGE_SIZE_CAP` (`common/pagination/list-query.schema.ts:4`); never redeclare it.
**BE-25.** Paginate live lists by cursor. A keyset page has no total and must not fake one.
**BE-26.** Permission keys are `module:resource:action`, lowercase, module segment first, 2–4 segments.
**BE-27.** Route params carry the entity — `:reimbursementId`, never `:id` — and must match the frontend folder. (gate: check:openapi-path-params)

## 4. Routes, Guards & Exposure

**BE-28.** Five guards are global, in this order: `RouteClassifierGuard`, `JwtAuthGuard`, `AdmissionGuard`, `MfaGuard`, `ModuleGuard`. (`app.module.ts:246`)
**BE-29.** `PermissionGuard` is **not** global. Without `@UseGuards(JwtAuthGuard, PermissionGuard)` a route is authenticated but unchecked.
**BE-30.** Declare exactly one exposure per route: `@Public()` | `@Universal()` | `@RequirePermission(...)` | `@AuthorizedInService("<what checks it>")`. Absence denies at boot. (gate: check:route-classification)
**BE-31.** To make a route universal, move the guard — never delete the key. *Why:* `PermissionGuard` denies a covered route with no key.
**BE-32.** Read identity from `@CurrentUser()`. Never accept `userId`, `actorId` or `orgId` from the client.
**BE-33.** Never write inside a GET. (gate: check:get-route-writes)
**BE-34.** Accept `Idempotency-Key` on mutating endpoints via `@Idempotent()`; replay the first result, 409 while in flight. (gate: check:idempotent-commands)
**BE-35.** Give every `@UseRateLimit("key")` a matching `TIERS` entry. An unknown tier denies and logs.
**BE-36.** Versioning is URI-based with the current version aliased to the unversioned path (`common/openapi/configure-api-versioning.ts`).

## 5. Database & Schema

**BE-37.** PKs are UUID or `generatedAlwaysAsIdentity()`. Never `serial`.
**BE-38.** Give every tenant table a non-nullable indexed `org_id` FK.
**BE-39.** Store money as integer cents.
**BE-40.** Make per-org business keys `uniqueIndex(org_id, col)`. *Why:* a global unique lets one tenant block every other.
**BE-41.** Catch `23505` and throw `ConflictException`, never a 500.
**BE-42.** Normalize lifecycle entities into tables. Never a JSONB array. *Why:* cannot be indexed, paginated or soft-deleted.
**BE-43.** Ban `entity_type` + `entity_id` on new tables. Use an exclusive arc or a link table per relationship.
**BE-44.** Lead composite indexes with `org_id`, then filter columns, then projected columns. (gate: check:tenant-indexes)
**BE-45.** Index every foreign key. (gate: check:restrict-fks, check:tenant-relationships)
**BE-46.** Never use an unprojected relation to global `users`. *Why:* those rows still hold authentication secrets.
**BE-47.** Remove N+1 with a join or one grouped query. (gate: check:n1-growing-loops, check:db-call-count)
**BE-48.** Wrap multi-step writes in one `db.transaction`, passing `tx` down.
**BE-49.** Search with `to_tsvector` + GIN or `pg_trgm`. Never a leading-wildcard `ILIKE`.
**BE-50.** Set `deleted_at` on new business tables and filter it in every read. Existing exemptions are a shrink-only list (see Open Questions). (gate: check:lifecycle-predicates)
**BE-51.** Make indexes on soft-deletable tables partial, excluding deleted rows.
**BE-52.** Hard-delete only link rows, unsent drafts, terminal invitations, revoked sessions and DPDP/GDPR erasure.
**BE-53.** Archive and restore organization hierarchy. Never add a permanent-delete control.
**BE-54.** Remember a soft-deleted parent never fires a child's `onDelete: "cascade"`.
**BE-55.** `prepare: false` is set (`db/pool.config.ts:288`), so `sql.placeholder` is inert — optimize with indexes and projection.
**BE-56.** Partition an append-only table only with its triggering row count recorded in the migration. The partition key must join every PK/UNIQUE.

## 6. Migrations

**BE-57.** Hand-author every `.sql`. `db:generate` is unusable on this schema. (gate: check:db-generate-guard)
**BE-58.** Register every migration in `migrations/meta/_journal.json`. *Why:* an unjournalled file never runs and `db:migrate` still prints success.
**BE-59.** Keep `idx` unique and `when` strictly increasing. Never renumber an existing entry to close a gap.
**BE-60.** Never edit an applied migration. Its hash is its identity. (gate: check:migration-immutability)
**BE-61.** Add nullable → backfill in batches → set NOT NULL. One purpose per migration.
**BE-62.** Add an FK as `NOT VALID`, then `VALIDATE CONSTRAINT`. *Why:* one step takes ACCESS EXCLUSIVE on both tables.
**BE-63.** For NOT NULL: `CHECK (col IS NOT NULL) NOT VALID` → `VALIDATE` → `SET NOT NULL` → drop the CHECK separately.
**BE-64.** Set `lock_timeout` (~5s) in every migration so it fails fast instead of queueing behind the table.
**BE-65.** Build indexes concurrently on large tables and name every constraint and index explicitly.
**BE-66.** Prove a migration by replaying it on an empty DB. Applying it to a branch is not proof. (gate: check:migration-chain, migration:proof)
**BE-67.** Create `vector`, `pg_trgm`, `btree_gist`, `pgcrypto`, `uuid-ossp` before `db:migrate`. Never fold this into `0000`.
**BE-68.** Prepend `SET statement_timeout = 0;` to heavy catalog `DO`-block migrations. *Why:* Neon cancels them on a cold build.
**BE-69.** Convert a unique index an FK targets with `ADD CONSTRAINT … UNIQUE USING INDEX`. *Why:* the dependent FK blocks a drop.
**BE-70.** Split reconciliation into dependency-ordered migrations. *Why:* a ~2000-op monolith ECONNRESETs on Neon.
**BE-71.** Ship a rollback for every destructive migration. (gate: check:migration-rollback, check:drop-column-safety)

## 7. Tenancy & RLS

**BE-72.** RLS is live on 328 tables. `app.current_org_id()` fails closed with `42501` when the GUC is absent.
**BE-73.** Wrap tenant work in `runInTenantTransaction`. *Why:* guards run before interceptors and have no GUC.
**BE-74.** Give every tenant table an explicit policy. *Why:* grants arrive via `ALTER DEFAULT PRIVILEGES`, so a missing policy reads org-wide and is silent.
**BE-75.** Exemptions are the 8 entries of `PLATFORM_GLOBAL_TABLES` in `src/scripts/db-verify-rls.mjs`, pinned by `test/security/rls-exemption-allowlist.spec.ts`. That list may only shrink.
**BE-76.** Benchmark as `streamline_app` with the tenant GUC set. *Why:* the owner has BYPASSRLS and hides every problem.
**BE-77.** Measure in buffers, not milliseconds. *Why:* wall-clock lies on a warm cache.
**BE-78.** `VACUUM ANALYZE` after any table rewrite.
**BE-79.** Put `org_id` inside any covering index on an RLS table. *Why:* the policy qual is not leakproof, so index-only scans need it supplied.
**BE-80.** Never propose `ALTER FUNCTION … LEAKPROOF` — it is impossible on Neon. Use an id-only `SECURITY DEFINER` function (`app.search_ticket_ids`) for text search under RLS.
**BE-81.** Split an `OR` between an indexed predicate and a semi-join into a `UNION`. *Why:* the OR defeats both indexes.

## 8. Side Effects & Reliability

**BE-82.** Never let a fire-and-forget call borrow the request transaction. *Why:* it has committed, so every read dies 42501. (gate: check:fire-and-forget, check:request-txn-outbound)
**BE-83.** Pick the mechanism by crash cost — atomic DB write → inside the transaction; leaves the process and loss is a bug → `OutboxWriter.emit(tx, …)`; must not run unless committed → `registerAfterCommit`.
**BE-84.** Never make a network call inside the request transaction. *Why:* it holds a pooled connection through someone else's outage.
**BE-85.** Handle `registerAfterCommit` returning `false` by running inline. Never drop the work.
**BE-86.** Resolve recipients and ids while the request transaction is live, never on the dead handle.
**BE-87.** Iterate background sweeps with `forEachOrg`. *Why:* they have no ambient tenant context.
**BE-88.** Never swallow a deferred failure. (gate: check:bare-throw, check:outbox-consumers)
**BE-89.** Set a timeout on every outbound call. (gate: check:outbound-timeouts)

## 9. Security

**BE-90.** Re-assert the caller's access to the specific object on every read and write taking a resource id. (gate: check:record-access, check:scope-boundary)
**BE-91.** Return 404 for a cross-tenant miss, never 403. *Why:* 403 confirms the record exists.
**BE-92.** Reject client-sent `role`, `isAdmin` and `orgId`.
**BE-93.** Reserve AI credits atomically before the paid call; refund only on provider failure. (gate: check:ai-charge)
**BE-94.** Short-circuit before embedding when the org has no eligible content. *Why:* anonymous denial-of-wallet.
**BE-95.** Fetch user-supplied URLs only through `common/security/ssrf-guard.ts`. *Why:* a fresh guard misses the packed `::ffff:7f00:1` form.
**BE-96.** Filter AI retrieval by the asker's access in the SQL predicate, never in the prompt.
**BE-97.** Keep AI out of the authorization decision path and permission data out of model providers.
**BE-98.** Hash passwords with Argon2id (m ≥ 19456 KiB, t = 2, p = 1).
**BE-99.** Read env only through `@nestjs/config`. (gate: check:process-env-ratchet — also an eslint error)
**BE-100.** Never hard-code or log a secret. (gate: check:hardcoded-secrets, check:log-secrets)
**BE-101.** Write the Redis tombstone on every session-revocation path. It is a cache; `user_sessions.is_revoked` is the authority.

## 10. RBAC

**BE-102.** There are exactly six standings — org owner/admin/member and module owner/admin/member. Never add a seventh, never ship role creation.
**BE-103.** Resolve permissions from the DB on every request via `AccessService`. Never from JWT claims.
**BE-104.** Ask `administeringModuleOf(key)` whether a key belongs to a module. Never `split(":")[0]`.
**BE-105.** `MODULE_CATALOG` is plan gating, not the module list. *Why:* adding a universal surface there 403s every route it owns.
**BE-106.** Give a module its admin rung through `MODULE_ADMIN_MODULES`.
**BE-107.** `MembershipStateService.resolve` is the only definition of a live membership.
**BE-108.** Merge `EMPLOYEE_SELF_SERVICE_GRANTS` before any role is read. *Why:* no revocation may remove self-service.
**BE-109.** Keep durable per-person capability in `user_permission_grants`. It survives a role change.
**BE-110.** Never delegate the `billing:` namespace, including the org owner's own.
**BE-111.** Widen a role template and let `RoleGrantReconcilerService` converge at boot. Never backfill grants by migration. *Why:* the new key violates the FK until catalog sync runs.
**BE-112.** Add a key to the backend catalog and the frontend catalog together, or `useCan` is false forever. (gate: check:permission-keys)
**BE-113.** Apply DataScope from `req.rbacScope` — `own` → `assignedToId = actor.userId`; `none` → deny.
**BE-114.** Call `bumpPermissionsVersion(tx, orgId)` in the same transaction as every role or permission mutation.
**BE-115.** Test org-admin structurally via `organizationMembers.role` / `isOwner`. *Why:* gating on `settings:manage` creates a parallel superuser.
**BE-116.** Treat `<module>:access:manage` as view-only. It never creates management authority.
**BE-117.** Gate a scope-widening optional `userId` on the scopable key's DataScope, not a sibling `manage` key. *Why:* `manage` sits beside `view` in the same roles, so it is a no-op.
**BE-118.** Never reintroduce `@CheckAbility`, `AbilityGuard`, `@casl/*`, `requireAuthorize` or `hasRoleOrPrivileged`.

## 11. Caching

**BE-119.** Invalidate explicitly on every mutation. (gate: check:cache-invalidation)
**BE-120.** Put every response-shaping filter in the cache key. *Why:* a filtered result under an unfiltered key leaks both ways. (gate: check:cache-key-shapes)
**BE-121.** Read with `cachedVersioned`; make every writer bump `invalidateNamespace`. (gate: check:namespace-coverage)
**BE-122.** Add no new request-path `invalidatePattern` or wildcard `SCAN`.
**BE-123.** Never share a cached result across tenants, actors or permission versions.
**BE-124.** Never give an authenticated personalized response HTTP/CDN caching.
**BE-125.** Keep quota, credits, seat admission and payment as atomic DB invariants, never cache-derived.
**BE-126.** Single-flight fills in-process; add a distributed lease, TTL jitter and stale-while-revalidate for hot shared keys.

## 12. Performance

**BE-127.** Assemble AI prompt context in the fewest queries, with explicit projections and hard row and text caps.
**BE-128.** Hash the source text, not the rejoined chunks, before re-embedding.
**BE-129.** Choose the vector strategy before the query from the tenant's cached chunk count and the cap — exact below the threshold, ANN above. *Why:* HNSW lost 3–56% recall while still returning exactly `LIMIT` rows.
**BE-130.** Raise `hnsw.ef_search` to scale with the cap. *Why:* pgvector needs `ef_search ≥ LIMIT`.
**BE-131.** Keep every threshold a named exported constant beside the decision (`modules/kb/retrieval/kb-retrieval-strategy.ts`).
**BE-132.** Keep list reads bounded. (gate: check:unbounded-reads, check:route-budgets)
**BE-133.** Health is hand-rolled in `src/health/health.controller.ts`. `@nestjs/terminus` is not installed — do not import it.

## 13. Testing & Verification

**BE-134.** Write the failing test before changing behavior. Its name carries the reason. *Why:* code comments are banned.
**BE-135.** Ship controller e2e specs for a new module — auth, RBAC allow/deny, scope, credit exhaustion, cross-tenant isolation.
**BE-136.** Make a `db.transaction` mock invoke its callback. *Why:* a bare `jest.fn()` voids every assertion inside it. (gate: check:transaction-callbacks)
**BE-137.** `*e2e-spec.ts` runs only under `pnpm test:e2e`.
**BE-138.** Run `pnpm typecheck:test` after any signature change. *Why:* typecheck is the only gate that sees arity.
**BE-139.** Give tsc 10240 MB. *Why:* at 8192 it dies exit 134 printing no type errors.
**BE-140.** Boot the API and exercise the real request for notifications, sweeps, RLS and post-commit work. *Why:* a swallowed 42501 passes every static check.
**BE-141.** Pair every negative assertion with a positive one. *Why:* a status-only negative passes on a 500.
**BE-142.** There is no Prettier and no coverage threshold in this repo. Do not assume formatting or coverage is enforced.

---

## Non-negotiables — these block a PR

1. **BE-30** — every route declares one exposure, or it denies at boot.
2. **BE-29** — a route needing a permission carries `PermissionGuard` explicitly; the decorator alone gates nothing.
3. **BE-90 / BE-91** — object-level authz on reads and writes; cross-tenant miss is 404.
4. **BE-32** — identity comes from `@CurrentUser()`, never the client.
5. **BE-58** — no migration ships unregistered in `_journal.json`.
6. **BE-60** — no applied migration is ever edited.
7. **BE-82** — no side effect borrows the request transaction.
8. **BE-112** — no permission key lands in one catalog only.
9. **BE-13** — every boundary parses with `.strict()`.
10. No `any`, no `as X`, no `@ts-ignore`. (gate: check:type-assertions — hard zero)

## Definition of Done — backend task

- [ ] Customer acceptance criteria verified against the real endpoint, not a mock.
- [ ] `pnpm typecheck` **and** `pnpm typecheck:test` pass (BE-138).
- [ ] `pnpm lint` passes; no new `^_` escapes added to silence unused-vars.
- [ ] Every gate named by a rule you touched passes, `:self-test` first (BE-139 caveat applies).
- [ ] Authorization tested with two accounts in two orgs; denial is 404 cross-tenant, 403 in-tenant.
- [ ] Every new/changed cache key lists resource, tenant, actor scope, filters, version, TTL, writers and post-commit invalidation.
- [ ] Any migration replayed on an empty DB, journalled, and rollback authored.
- [ ] Regressions separated from pre-existing failures on a clean tree.
- [ ] Unrun checks stated explicitly. No zero-bug or quality-score claim from static checks.

## Anti-patterns seen in this repo

| Where | Wrong | Right |
|---|---|---|
| `common/pagination/pagination.ts:14` | private `const PAGE_SIZE_MAX = 100;` duplicating the exported cap | import `PAGE_SIZE_CAP` from `list-query.schema.ts:4` (BE-24) |
| `tsconfig.json:15` | `"@casl/ability": ["node_modules/@casl/ability/…"]` — maps a package that is **not installed** | delete the path mapping (BE-118) |
| `modules/billing/core/platform-promotions.controller.ts:64` | `const [created] = await this.db…` in a controller | move the query into the service (BE-06) |
| `modules/payroll/runs/salary-profiles.repository.ts` | the only `*.repository.ts` in 1,196 services — a layer that exists once | keep controller → service → Drizzle (BE-05) |
| schema-wide | 92 of 877 tables carry `deleted_at` while the rule claims soft delete is universal | set `deleted_at` on new business tables; record exemptions in a shrink-only list (BE-50) |

## Open questions — decide these

1. **`AdmissionGuard`'s position** (third, between `JwtAuthGuard` and `MfaGuard`) is undocumented. Is the order deliberate? *Recommended default:* yes — document it in BE-28 and pin it with a spec.
2. **BE-50 has no exemption allowlist**, so it cannot be ratcheted. *Recommended default:* generate `soft-delete-exempt.json` from today's 785 non-compliant tables, then require new tables to comply and let the list only shrink.
3. **42 controllers hold `this.db`** (BE-06) with no ratchet file. *Recommended default:* same treatment — freeze the list, forbid additions.
4. **87 no-arg `db.select()` call sites** vs 161 projected. Unclassified. *Recommended default:* audit once, then extend `check:query-projections` beyond `modules/build/**`.
5. **No Prettier, no coverage threshold.** *Recommended default:* leave both off — adding Prettier now reformats 1,196 services in one diff; add a coverage floor only for `common/**` if you want one.

<details>
<summary>Deleted and merged points (restore anything cut wrongly)</summary>

**Deleted**
- *"Config: `@nestjs/config` global + startup `validationSchema`, `.env` out of git, commit `.env.example`"* — restates framework setup that is already done and unenforced; the only actionable half survives as BE-99.
- *"Input/output: Zod-validate all input; parameterized ORM queries only; sanitize rendered HTML; secure cookies"* — Zod half duplicates BE-12; Drizzle parameterizes by construction; the HTML/cookie halves were unenforceable as written and have no gate.

**Merged**
- *"Guards deny by default"* (old §2) → folded into BE-30.
- *"Select only needed columns; no N+1; multi-step writes in one transaction"* (old §3) → split into BE-07, BE-47, BE-48.
- *"Benchmark as `streamline_app`… VACUUM ANALYZE"* appeared in both §3 and §7 → single statement at BE-76/BE-77/BE-78.
- *"Measure in buffers, not milliseconds"* (old §7) → BE-77.
- *"Record the writer/scope matrix before extending a cache"* — verbatim duplicate of root §9 → kept only in the Definition of Done.
- *"No hard-coded secrets; validate uploads; log sensitive actions"* → BE-100.
- *"Capability is narrowed per person, not by inventing a role"* → overlapped BE-102 and BE-109.
- *"Guards on every privileged route… Helmet, strict CORS, retire old versions, sanitize upstream responses"* — eight rules in one bullet → BE-30, BE-90, BE-92, BE-95; the Helmet/CORS/version-retirement clauses had no gate and no current violation, and were dropped.
- *"Stateless handlers, structured logging, graceful shutdown"* → only the checkable half survives as BE-133.

**Narrative compressed, substance retained** — the RLS/`LEAKPROOF` finding (BE-80), the post-commit `42501` outage (BE-82), and the HNSW recall measurement (BE-129/BE-130) kept their numbers and mechanisms; only the incident prose was cut.

</details>
