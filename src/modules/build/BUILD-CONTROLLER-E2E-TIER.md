# Build Controller E2E Tier — what it can and cannot prove

## What this tier proves

**Guard chain wiring is correct.**
Six global guards fire before every handler in this order:
`RouteClassifierGuard → JwtAuthGuard → RateLimitGuard → AdmissionGuard → MfaGuard → ModuleGuard`.
`PermissionGuard` is controller-scoped (not global). A missing `@UseGuards(JwtAuthGuard, PermissionGuard)` leaves a route unchecked.

Each spec asserts:
- A request without a token receives `401 UNAUTHORIZED`.
- A request with a valid token but without the required permission key receives `403 FORBIDDEN`.
- A request with the exact required permission key and a stubbed service receives `200` (or `201`/`204`).

The `200` assertion is sensitive: if the handler throws, the response is `500`, and `toBe(200)` fails. This is what BE-141 demands — a status-only negative passes on a `500`.

**Module gate is wired.**
The `402 MODULE_NOT_ENABLED` assertions in `build-execution.controller.e2e-spec.ts` prove the `ModuleGuard` is evaluated before the handler and that the `build` module key is attached to the right controllers.

**Idempotency fence is enforced before the handler.**
`approvals.controller.e2e-spec.ts` proves that a `POST /build/1/approvals` without an `Idempotency-Key` header receives `400` — the fence guard runs before `ApprovalsService.createApproval` is ever called.

**Zod validation fires before the service.**
`forms/build-forms.controller.e2e-spec.ts` proves that cycle-detection and numeric-operator-type checks in `createFormSchema` return `400` before `FormsService.createForm` is called. The stubbed service is never invoked for these cases.

**Cross-tenant service errors are surfaced correctly.**
`updates/updates-cross-tenant.e2e-spec.ts` proves that when `UpdatesService.listUpdates` throws `NotFoundException`, the response is `404 not 403` (BE-91: cross-tenant miss is 404, never 403 which confirms existence).

**Inactive membership is denied before the service.**
Same cross-tenant spec proves that an overridden `MembershipStateService` returning `{ active: false }` causes `AdmissionGuard` to deny with `403 ORG_MEMBERSHIP_INACTIVE` before the service is called.

## What this tier does NOT prove

**No production DB is involved.**
Every spec overrides `DRIZZLE` with `{}`. NestJS's `TestingModuleBuilder` replaces the provider in the DI container before `compile()` executes, so the real `postgres(DATABASE_URL)` call is never made. The `{}` stub also fails `createE2eApp`'s seeding check (`typeof ({}).transaction === "function"` is false), preventing any INSERT to production.

**No real business logic is exercised.**
All service methods are `jest.fn()` stubs. The tier cannot prove:
- That a project-not-found case returns 404 from the business layer.
- That RLS policies enforce cross-tenant isolation at the DB level.
- That audit logs, outbox events, or cache invalidations are emitted on writes.
- That paginated queries obey `PAGE_SIZE_CAP`.
- That concurrent writes behave correctly under a transaction.

**No real webhooks, emails, or messages are sent.**
Worker services (`PayrollJobsWorkerService`, `NotificationDeliveryWorker`, etc.) are stubbed by `createE2eApp` itself. No external side effects occur.

**SprintsService is intentionally excluded from success assertions.**
`SprintsService.listSprints` and `getSprint` return `Promise<never>` (always throw). Sprint endpoints in `build-execution.controller.e2e-spec.ts` are covered by 401/403/402 tests only. `CyclesService` is used instead for the 200-assertion in that spec.

## Broken-handler proof case

`workflow/build-workflow.controller.e2e-spec.ts` contains a deliberate `it.skip(...)` case named
`"BROKEN-HANDLER-proof: list-transitions returns 200 — remove skip to see failure when handler always throws"`.

To observe it go red:
1. Open `backend/src/modules/build/workflow/build-workflow.controller.e2e-spec.ts`.
2. Delete the `.skip` from `it.skip("BROKEN-HANDLER-proof: ..."`.
3. Run: `pnpm test:e2e --testPathPattern=build-workflow.controller.e2e-spec`.
4. Expected output: `FAIL — Expected: 200, Received: 500`.

The case creates a fresh app with `WorkflowService.listTransitions` that always rejects, then asserts `200`. When the handler throws, NestJS's exception filter maps it to `500` and the `toBe(200)` assertion fails — proving the positive assertion is genuinely sensitive to handler breakage.

## Structural guarantee (per spec)

Every spec in this tier applies the same two-provider override:

```
{ provide: DRIZZLE, useValue: {} }          // prevents postgres() connection
{ provide: XxxService, useValue: stub }     // prevents DB queries in handler
```

The `DRIZZLE` override works because `DrizzleModule`'s factory (`postgres(DATABASE_URL)`) is replaced before `compile()` runs. All services that inject `DRIZZLE` receive `{}`. Since NestJS instantiates providers lazily (constructor assigns `this.db = db`, never calls it), no connection pool is created. The stubbed service's methods never access `this.db`, so even if DRIZZLE were real, no query would run.

Guards that consult `AccessService`, `EntitlementsService`, `MembershipStateService`, and `MfaPolicyService` are handled by `createE2eApp`'s built-in stubs — no guard-level DB call is possible either.
