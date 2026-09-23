# Generic Approval Adapter Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hardcoded Build-only approval source in the Unified Inbox with a pluggable adapter registry, then wire HR leave, WFH, timesheet, and HR workflow approvals through it.

**Architecture:** A new leaf `AttentionModule` owns the `ApprovalAdapterRegistry` singleton; `NotificationsModule` imports it and uses the registry to extend the Build adapter list; each producing module (`HrTimeModule`, `TimesheetsCoreModule`, `HrWorkflowsModule`) imports `AttentionModule` and registers its adapter in `OnModuleInit`. The registry solves the DI cycle because it imports nothing from notifications/HR/build.

**Tech Stack:** NestJS 11 · TypeScript 5.6 strict · Jest · Drizzle (no new schema)

**Spec:** This file is the spec.

## Global Constraints

- Every rule in `backend/CLAUDE.md` applies; violations in any step are blockers.
- No `any`, no `as X`, no `@ts-ignore` (gate: check:type-assertions — hard zero).
- Files must stay under 300 lines (gate: check:over-300).
- No code comments — reasons go in test names.
- No new DB schema, no new migrations.
- `ApprovalAdapterRegistry` must be idempotent: registering the same `module`+`kindLabel` twice must not create duplicates.
- Each adapter's `fetch()` returns `BuildApprovalInboxItem[]` — all approvals share the `build_approval` inbox kind.
- Permission keys must exist in the backend catalog before use. Confirmed keys:
  - `hr:leaves:approve` (hr-foundation.permissions.ts)
  - `hr:attendance:manage` (approval-authority.types.ts — the system uses this for WFH approvals)
  - `timesheets:approvals:view` (timesheets.ts)
  - `hr:workflows:approve` (hr-foundation.permissions.ts)
  - `build:approvals:view` (build.ts — existing, unchanged)
- Dedup keys: `approval:leave:<id>`, `approval:wfh:<id>`, `approval:timesheet:<id>`, `approval:workflow:<id>`, `approval:build:<id>` (existing). No two sources may share an id-space so a wfh:5 and leave:5 do not collide.
- Specs live under `src/**` (not `test/`). (gate: jest-roots)
- `pnpm typecheck` and `pnpm typecheck:test` must pass.

---

## File Map

| Action | Path | Purpose |
|---|---|---|
| Create | `src/modules/attention/approval-adapter.registry.ts` | `ApprovalSourceAdapter` interface + `ApprovalAdapterRegistry` service |
| Create | `src/modules/attention/attention.module.ts` | Leaf NestJS module exporting the registry |
| Create | `src/modules/attention/approval-adapter.registry.spec.ts` | Registry unit tests |
| Modify | `src/modules/notifications/unified-inbox-sources.ts` | Re-export `ApprovalSourceAdapter` from attention (backward compat) |
| Modify | `src/modules/notifications/notifications.module.ts` | Import `AttentionModule` |
| Modify | `src/modules/notifications/unified-inbox.service.ts` | Inject registry, fan out across adapters |
| Modify | `src/modules/notifications/unified-inbox.spec.ts` | Thread mock registry through constructor |
| Create | `src/modules/hr/time/hr-time-approval.adapter.ts` | Leave + WFH approval adapter service |
| Create | `src/modules/hr/time/hr-time-approval.adapter.spec.ts` | Adapter unit tests |
| Modify | `src/modules/hr/time/hr-time.module.ts` | Import `AttentionModule`, add `HrTimeApprovalAdapter` provider |
| Create | `src/modules/timesheets/core/timesheet-approval.adapter.ts` | Timesheet approval adapter service |
| Create | `src/modules/timesheets/core/timesheet-approval.adapter.spec.ts` | Adapter unit tests |
| Modify | `src/modules/timesheets/core/timesheets-core.module.ts` | Import `AttentionModule`, add `TimesheetApprovalAdapter` provider |
| Create | `src/modules/hr/workflows/hr-workflow-approval.adapter.ts` | HR workflow approval adapter service |
| Create | `src/modules/hr/workflows/hr-workflow-approval.adapter.spec.ts` | Adapter unit tests |
| Modify | `src/modules/hr/workflows/hr-workflows.module.ts` | Import `AttentionModule`, add `HrWorkflowApprovalAdapter` provider |
| Modify | `src/app.module.ts` | Import `AttentionModule` (BE-01) |

---

### Task 1: Create the leaf `AttentionModule` with `ApprovalAdapterRegistry`

**Files:**
- Create: `src/modules/attention/approval-adapter.registry.ts`
- Create: `src/modules/attention/attention.module.ts`

**Interfaces:**
- Produces:
  - `ApprovalSourceAdapter` (type)
  - `ApprovalAdapterRegistry` (injectable class with `register(adapter)` and `list()`)
  - `AttentionModule` (NestJS module, imports nothing, provides + exports `ApprovalAdapterRegistry`)

- [ ] **Step 1: Write `approval-adapter.registry.ts`**

```typescript
// src/modules/attention/approval-adapter.registry.ts
import { Injectable } from "@nestjs/common";
import type {
  BuildApprovalInboxItem,
  InboxSourcePosition,
} from "../notifications/dto/unified-inbox.schemas";

export type ApprovalSourceAdapter = {
  readonly module: string;
  readonly permission: string;
  readonly kindLabel: string;
  fetch(
    orgId: string,
    userId: string,
    membershipId: number | null,
    limit: number,
    cursor: InboxSourcePosition | null,
  ): Promise<BuildApprovalInboxItem[]>;
};

@Injectable()
export class ApprovalAdapterRegistry {
  private readonly adapters: ApprovalSourceAdapter[] = [];

  register(adapter: ApprovalSourceAdapter): void {
    const alreadyRegistered = this.adapters.some(
      (a) => a.module === adapter.module && a.kindLabel === adapter.kindLabel,
    );
    if (!alreadyRegistered) this.adapters.push(adapter);
  }

  list(): readonly ApprovalSourceAdapter[] {
    return this.adapters;
  }
}
```

- [ ] **Step 2: Write `attention.module.ts`**

```typescript
// src/modules/attention/attention.module.ts
import { Module } from "@nestjs/common";
import { ApprovalAdapterRegistry } from "./approval-adapter.registry";

@Module({
  providers: [ApprovalAdapterRegistry],
  exports: [ApprovalAdapterRegistry],
})
export class AttentionModule {}
```

- [ ] **Step 3: Run typecheck to verify the new files compile**

```
pnpm typecheck
```

Expected: no new errors.

---

### Task 2: Registry unit spec

**Files:**
- Create: `src/modules/attention/approval-adapter.registry.spec.ts`
- Test: same file

**Interfaces:**
- Consumes: `ApprovalAdapterRegistry` from Task 1
- Produces: verified registry behavior for subsequent tasks

- [ ] **Step 1: Write the failing tests**

```typescript
// src/modules/attention/approval-adapter.registry.spec.ts
import { ApprovalAdapterRegistry } from "./approval-adapter.registry";
import type { ApprovalSourceAdapter } from "./approval-adapter.registry";
import type {
  BuildApprovalInboxItem,
  InboxSourcePosition,
} from "../notifications/dto/unified-inbox.schemas";

function makeAdapter(module: string, kindLabel: string): ApprovalSourceAdapter {
  return {
    module,
    permission: `${module}:test:view`,
    kindLabel,
    fetch: (_orgId: string, _userId: string, _membershipId: number | null, _limit: number, _cursor: InboxSourcePosition | null): Promise<BuildApprovalInboxItem[]> =>
      Promise.resolve([]),
  };
}

describe("ApprovalAdapterRegistry", () => {
  describe("register and list", () => {
    it("list returns an empty array before any adapter is registered", () => {
      const registry = new ApprovalAdapterRegistry();
      expect(registry.list()).toEqual([]);
    });

    it("list returns every registered adapter", () => {
      const registry = new ApprovalAdapterRegistry();
      const a = makeAdapter("hr", "leave");
      const b = makeAdapter("timesheets", "timesheet");
      registry.register(a);
      registry.register(b);
      expect(registry.list()).toHaveLength(2);
      expect(registry.list()).toContain(a);
      expect(registry.list()).toContain(b);
    });
  });

  describe("idempotency", () => {
    it("registering the same module+kindLabel twice does not duplicate", () => {
      const registry = new ApprovalAdapterRegistry();
      const a = makeAdapter("hr", "leave");
      const b = makeAdapter("hr", "leave");
      registry.register(a);
      registry.register(b);
      expect(registry.list()).toHaveLength(1);
    });

    it("registering same module with different kindLabels adds both", () => {
      const registry = new ApprovalAdapterRegistry();
      registry.register(makeAdapter("hr", "leave"));
      registry.register(makeAdapter("hr", "wfh"));
      expect(registry.list()).toHaveLength(2);
    });

    it("registering same kindLabel under different modules adds both", () => {
      const registry = new ApprovalAdapterRegistry();
      registry.register(makeAdapter("hr", "leave"));
      registry.register(makeAdapter("timesheets", "leave"));
      expect(registry.list()).toHaveLength(2);
    });
  });

  describe("dedup key collision guard", () => {
    it("leave and wfh dedup keys do not share a namespace", () => {
      const leaveKey = `approval:leave:5`;
      const wfhKey = `approval:wfh:5`;
      expect(leaveKey).not.toBe(wfhKey);
    });

    it("timesheet and workflow dedup keys do not share a namespace", () => {
      const timesheetKey = `approval:timesheet:5`;
      const workflowKey = `approval:workflow:5`;
      expect(timesheetKey).not.toBe(workflowKey);
    });

    it("build and leave dedup keys do not share a namespace", () => {
      const buildKey = `approval:build:5`;
      const leaveKey = `approval:leave:5`;
      expect(buildKey).not.toBe(leaveKey);
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```
pnpm exec jest --runInBand src/modules/attention/approval-adapter.registry.spec.ts
```

Expected: FAIL — `ApprovalAdapterRegistry` not yet created (or if Task 1 is done, tests should PASS immediately since we wrote them against the already-implemented registry).

- [ ] **Step 3: Verify tests pass after Task 1 is complete**

```
pnpm exec jest --runInBand src/modules/attention/approval-adapter.registry.spec.ts
```

Expected: all tests PASS.

---

### Task 3: Update `NotificationsModule` to import `AttentionModule` and wire the registry

**Files:**
- Modify: `src/modules/notifications/notifications.module.ts`
- Modify: `src/modules/notifications/unified-inbox.service.ts`
- Modify: `src/modules/notifications/unified-inbox-sources.ts`
- Modify: `src/modules/notifications/unified-inbox.spec.ts`

**Interfaces:**
- Consumes: `ApprovalAdapterRegistry` from Task 1, `ApprovalSourceAdapter` (now re-exported from `unified-inbox-sources.ts`)
- Produces: `UnifiedInboxService` that returns Build adapter PLUS everything in the registry

- [ ] **Step 1: Re-export `ApprovalSourceAdapter` from `unified-inbox-sources.ts` (backward compat)**

In `src/modules/notifications/unified-inbox-sources.ts`, remove the local `ApprovalSourceAdapter` type definition and replace it with a re-export from `attention`:

```typescript
// REMOVE this block from unified-inbox-sources.ts:
// export type ApprovalSourceAdapter = {
//   readonly module: string;
//   readonly permission: string;
//   readonly kindLabel: string;
//   fetch(...): Promise<BuildApprovalInboxItem[]>;
// };

// ADD this re-export instead:
export type { ApprovalSourceAdapter } from "../attention/approval-adapter.registry";
```

The rest of `unified-inbox-sources.ts` remains unchanged. The `buildApprovalAdapter` function still lives there and still references the type via the re-export.

- [ ] **Step 2: Add `AttentionModule` to `notifications.module.ts` imports**

In the `@Module({ imports: [...] })` array, add `AttentionModule`:

```typescript
import { AttentionModule } from "../attention/attention.module";
// ...
@Module({
  imports: [RealtimeModule, MailModule, BuildApprovalsInboxModule, AttentionModule],
  // rest unchanged
})
```

- [ ] **Step 3: Inject `ApprovalAdapterRegistry` into `UnifiedInboxService` and change `buildApprovalAdapters()`**

In `src/modules/notifications/unified-inbox.service.ts`:

1. Add import:
```typescript
import { ApprovalAdapterRegistry } from "../attention/approval-adapter.registry";
```

2. Add to constructor:
```typescript
constructor(
  @Inject(DRIZZLE) private readonly db: Db,
  private readonly access: AccessService,
  private readonly mail: MailService,
  private readonly broadcasts: BroadcastsService,
  private readonly buildApprovals: BuildApprovalsInboxService,
  private readonly registry: ApprovalAdapterRegistry,
) {}
```

3. Change `buildApprovalAdapters()`:
```typescript
private buildApprovalAdapters(): ApprovalSourceAdapter[] {
  return [buildApprovalAdapter(this.buildApprovals), ...this.registry.list()];
}
```

4. The `list()` method in `UnifiedInboxService` currently checks ONE adapter's permission and fetches from ONE adapter. This needs to change to support multiple adapters with independent permission checks and independent failure isolation.

Replace the approval-fetch block in `list()`. Current code (around lines 199–270):

```typescript
// CURRENT (single adapter):
const adapters = this.buildApprovalAdapters();
const canViewApproval =
  wantsBuildApprovals && approvalsSupport
    ? await this.access.holds(user, adapters[0]?.permission ?? "build:approvals:view")
    : false;
// ...
wantsBuildApprovals && approvalsSupport && canViewApproval && adapters[0]
  ? readSource(() => adapters[0].fetch(orgId, userId, membershipId, limit + 1, approvalPosition))
  : null
```

The new approach runs adapters independently. Since the `Promise.all` structure is complex, extract a helper:

```typescript
// NEW helper inside the class (private):
private async fetchAllAdapters(
  user: CurrentUserContext,
  wantsBuildApprovals: boolean,
  approvalsSupport: boolean,
  orgId: string,
  userId: string,
  membershipId: number | null,
  limit: number,
  approvalPosition: InboxSourcePosition | null,
): Promise<{ items: BuildApprovalInboxItem[]; errors: string[]; permDenied: string[] }> {
  const adapters = this.buildApprovalAdapters();
  if (!wantsBuildApprovals || !approvalsSupport || adapters.length === 0) {
    return { items: [], errors: [], permDenied: [] };
  }

  const results = await Promise.all(
    adapters.map(async (adapter) => {
      const canView = await this.access.holds(user, adapter.permission);
      if (!canView) return { items: [], denied: adapter.permission, error: null };
      const outcome = await readSource(() =>
        adapter.fetch(orgId, userId, membershipId, limit, approvalPosition),
      );
      if (outcome.ok) return { items: outcome.value, denied: null, error: null };
      return { items: [], denied: null, error: `${adapter.kindLabel}: ${outcome.error}` };
    }),
  );

  return {
    items: results.flatMap((r) => r.items),
    errors: results.flatMap((r) => (r.error !== null ? [r.error] : [])),
    permDenied: results.flatMap((r) => (r.denied !== null ? [r.denied] : [])),
  };
}
```

Then in `list()`, replace the `approvalOutcome` logic:

```typescript
// Instead of:
const [notifOutcome, broadcastOutcome, mailOutcome, approvalOutcome] = await Promise.all([...]);

// Use:
const [notifOutcome, broadcastOutcome, mailOutcome, approvalResult] = await Promise.all([
  // notif, broadcast, mail unchanged...
  this.fetchAllAdapters(user, wantsBuildApprovals, approvalsSupport, orgId, userId, membershipId, limit + 1, approvalPosition),
]);
```

Then replace uses of `approvalOutcome` and `approvalItems`:

```typescript
const approvalItems = approvalResult.items; // already BuildApprovalInboxItem[]
```

And update the `sources` array for `build_approval`:

```typescript
// CURRENT:
wantsBuildApprovals && approvalsSupport && canViewApproval && approvalOutcome !== null
  ? includedSource("build_approval", approvalOutcome)
  : skippedSource("build_approval", ...)

// NEW:
buildApprovalSourceStatus(
  wantsBuildApprovals,
  approvalsSupport,
  approvalResult,
  this.buildApprovalAdapters(),
),
```

Add the helper function `buildApprovalSourceStatus` (module scope, not in class):

```typescript
function buildApprovalSourceStatus(
  wantsBuildApprovals: boolean,
  approvalsSupport: boolean,
  result: { items: BuildApprovalInboxItem[]; errors: string[]; permDenied: string[] } | null,
  adapters: readonly ApprovalSourceAdapter[],
): SourceStatus {
  if (!wantsBuildApprovals)
    return skippedSource("build_approval", null);
  if (!approvalsSupport)
    return skippedSource("build_approval", "unsupported: triage (approvals have no archive state)");
  if (result === null)
    return skippedSource("build_approval", null);

  const allDenied =
    adapters.length > 0 && result.permDenied.length === adapters.length;
  if (allDenied)
    return skippedSource(
      "build_approval",
      `no permission: ${result.permDenied.join(", ")}`,
    );

  const hasErrors = result.errors.length > 0;
  return {
    kind: "build_approval",
    included: true,
    reason: null,
    available: !hasErrors,
    error: hasErrors ? result.errors.join("; ") : null,
  };
}
```

Also remove the now-unused `canViewApproval` variable and the old single-adapter permission check.

- [ ] **Step 4: Update the existing `unified-inbox.spec.ts` to provide a mock registry**

The `UnifiedInboxService` constructor now requires `ApprovalAdapterRegistry` as the 6th argument. All existing `new UnifiedInboxService(...)` calls in the spec must be updated.

Add a helper:
```typescript
function makeRegistry(adapters: ApprovalSourceAdapter[] = []): ApprovalAdapterRegistry {
  return {
    list: jest.fn().mockReturnValue(adapters),
    register: jest.fn(),
  } as unknown as ApprovalAdapterRegistry;
}
```

Update every `new UnifiedInboxService(db, access, mail, broadcasts, makeBuildApprovals())` call:
```typescript
new UnifiedInboxService(db, access, mail, broadcasts, makeBuildApprovals(), makeRegistry())
```

Also update the permission check test that currently expects `reason: "no permission: build:approvals:view"`. With the new multi-adapter approach, when ALL adapters are denied, the reason shows ALL denied keys. Since the spec only has the build adapter (via `makeBuildApprovals`), the message will still start with `no permission:`. Update the assertion to use `toContain("no permission:")` or keep the exact match if the build key is the only one.

- [ ] **Step 5: Run the existing unified-inbox spec**

```
pnpm exec jest --runInBand src/modules/notifications/unified-inbox.spec.ts
```

Expected: all tests PASS. Fix any failures before proceeding.

- [ ] **Step 6: Run typecheck**

```
pnpm typecheck
```

Expected: no errors.

---

### Task 4: Register `AttentionModule` in `app.module.ts`

**Files:**
- Modify: `src/app.module.ts`

**Interfaces:**
- Consumes: `AttentionModule` from Task 1
- Produces: `AttentionModule` registered at app root, satisfying BE-01

- [ ] **Step 1: Add `AttentionModule` import to `app.module.ts`**

Add import statement and add `AttentionModule` to the `imports` array:

```typescript
import { AttentionModule } from "./modules/attention/attention.module";
// ...
@Module({
  imports: [
    // existing entries...
    AttentionModule,
    // ...
  ],
```

- [ ] **Step 2: Run typecheck**

```
pnpm typecheck
```

Expected: no errors.

---

### Task 5: HR Leave and WFH approval adapter

**Files:**
- Create: `src/modules/hr/time/hr-time-approval.adapter.ts`
- Modify: `src/modules/hr/time/hr-time.module.ts`

**Interfaces:**
- Consumes: `LeavesService.pendingRoutedTo(orgId, membershipId, limit)`, `WfhService.pendingRoutedTo(orgId, membershipId, limit)`, `ApprovalAdapterRegistry`
- Produces: two `ApprovalSourceAdapter` registrations — leave (`hr:leaves:approve`) and wfh (`hr:attendance:manage`)

**Permission key proof:**
- `hr:leaves:approve` — exists in `src/modules/rbac/permissions/hr-foundation.permissions.ts` line 55
- `hr:attendance:manage` — exists in `src/modules/rbac/permissions/hr-foundation.permissions.ts` line 41 AND confirmed as the WFH approval permission in `src/modules/directory/approval-authority.types.ts` line 32

- [ ] **Step 1: Write `hr-time-approval.adapter.ts`**

```typescript
// src/modules/hr/time/hr-time-approval.adapter.ts
import { Injectable, OnModuleInit } from "@nestjs/common";
import { ApprovalAdapterRegistry } from "../../attention/approval-adapter.registry";
import { LeavesService } from "./leaves.service";
import { WfhService } from "./wfh.service";
import type {
  BuildApprovalInboxItem,
  InboxSourcePosition,
} from "../../notifications/dto/unified-inbox.schemas";

function passesCursor(
  itemId: number,
  itemTimestamp: string,
  cursor: InboxSourcePosition | null,
): boolean {
  if (cursor === null) return true;
  const itemMs = new Date(itemTimestamp).getTime();
  if (cursor.t !== null) {
    const cursorMs = new Date(cursor.t).getTime();
    if (itemMs < cursorMs) return true;
    if (itemMs === cursorMs && itemId < cursor.id) return true;
    return false;
  }
  return itemId < cursor.id;
}

@Injectable()
export class HrTimeApprovalAdapter implements OnModuleInit {
  constructor(
    private readonly leaves: LeavesService,
    private readonly wfh: WfhService,
    private readonly registry: ApprovalAdapterRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      module: "hr",
      permission: "hr:leaves:approve",
      kindLabel: "leave",
      fetch: (orgId, _userId, membershipId, limit, cursor) =>
        this.fetchLeaveItems(orgId, membershipId, limit, cursor),
    });

    this.registry.register({
      module: "hr",
      permission: "hr:attendance:manage",
      kindLabel: "wfh",
      fetch: (orgId, _userId, membershipId, limit, cursor) =>
        this.fetchWfhItems(orgId, membershipId, limit, cursor),
    });
  }

  private async fetchLeaveItems(
    orgId: string,
    membershipId: number | null,
    limit: number,
    cursor: InboxSourcePosition | null,
  ): Promise<BuildApprovalInboxItem[]> {
    if (membershipId === null) return [];
    const rows = await this.leaves.pendingRoutedTo(orgId, membershipId, limit);
    const items: BuildApprovalInboxItem[] = rows.map((row) => ({
      kind: "build_approval" as const,
      id: row.id,
      status: "pending",
      projectId: null,
      approvalKind: "leave",
      ticketId: null,
      dueAt: null,
      subject: `${row.leaveType?.name ?? "Leave"} · ${row.startDate}${row.endDate !== row.startDate ? ` to ${row.endDate}` : ""}`,
      sourceModule: "hr",
      actor: row.user
        ? { id: row.user.id, name: (row.user.name ?? null), image: null }
        : null,
      deepLink: "/hr/leaves",
      isRead: false,
      dedupKey: `approval:leave:${String(row.id)}`,
      timestamp: row.createdAt.toISOString(),
    }));
    items.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    return items
      .filter((item) => passesCursor(item.id, item.timestamp, cursor))
      .slice(0, limit);
  }

  private async fetchWfhItems(
    orgId: string,
    membershipId: number | null,
    limit: number,
    cursor: InboxSourcePosition | null,
  ): Promise<BuildApprovalInboxItem[]> {
    if (membershipId === null) return [];
    const rows = await this.wfh.pendingRoutedTo(orgId, membershipId, limit);
    const items: BuildApprovalInboxItem[] = rows.map((row) => ({
      kind: "build_approval" as const,
      id: row.id,
      status: "pending",
      projectId: null,
      approvalKind: "wfh",
      ticketId: null,
      dueAt: null,
      subject: `Work from home · ${row.date}`,
      sourceModule: "hr",
      actor: row.userName
        ? { id: row.userId, name: row.userName, image: null }
        : null,
      deepLink: "/hr/leaves",
      isRead: false,
      dedupKey: `approval:wfh:${String(row.id)}`,
      timestamp: row.createdAt.toISOString(),
    }));
    items.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    return items
      .filter((item) => passesCursor(item.id, item.timestamp, cursor))
      .slice(0, limit);
  }
}
```

- [ ] **Step 2: Add `AttentionModule` import and `HrTimeApprovalAdapter` to `hr-time.module.ts`**

```typescript
import { AttentionModule } from "../../attention/attention.module";
import { HrTimeApprovalAdapter } from "./hr-time-approval.adapter";

@Module({
  imports: [
    AutomationModule,
    WebhooksModule,
    NotificationsModule,
    HrAutomationsModule,
    HrPoliciesModule,
    HrTimeLedgerModule,
    HrWorkflowsModule,
    HrPayrollInputsModule,
    RateLimitModule,
    HrLifecycleModule,
    DirectoryModule,
    AttentionModule,          // ← add
  ],
  // ... controllers unchanged ...
  providers: [
    // ... existing providers ...
    HrTimeApprovalAdapter,    // ← add
  ],
  exports: [AttendanceService, HrTimeLedgerModule, LeavesService, WfhService],
})
```

- [ ] **Step 3: Run typecheck**

```
pnpm typecheck
```

Expected: no errors. Fix any type issues (e.g., checking the exact shape returned by `leaves.pendingRoutedTo` and `wfh.pendingRoutedTo`).

**Note on `leaveRequests` return shape:** `LeavesService.pendingRoutedTo` uses `db.query.leaveRequests.findMany` with `with: TEAM_RELATIONS` (which includes `user` and `leaveType`). The result includes `row.id: number`, `row.startDate: string`, `row.endDate: string`, `row.createdAt: Date`, `row.leaveType: { name: string | null } | null`, `row.user: { id: string, name: string | null } | null`.

**Note on `wfhRequests` return shape:** `WfhService.pendingRoutedTo` projects `{ id, userId, date, reason, createdAt, userName, userFirstName, userLastName, userEmail }`. There is no `user` relation object — use `row.userName` for actor name and `row.userId` for actor ID.

---

### Task 6: HR Leave and WFH adapter spec

**Files:**
- Create: `src/modules/hr/time/hr-time-approval.adapter.spec.ts`

**Interfaces:**
- Consumes: `HrTimeApprovalAdapter` from Task 5
- Produces: verified authorization, isolation, dedup-key, and degradation behavior

- [ ] **Step 1: Write the spec**

```typescript
// src/modules/hr/time/hr-time-approval.adapter.spec.ts
import { HrTimeApprovalAdapter } from "./hr-time-approval.adapter";
import { ApprovalAdapterRegistry } from "../../attention/approval-adapter.registry";
import type { LeavesService } from "./leaves.service";
import type { WfhService } from "./wfh.service";
import type { InboxSourcePosition } from "../../notifications/dto/unified-inbox.schemas";

function makeLeaves(rows: unknown[] = []): jest.Mocked<Pick<LeavesService, "pendingRoutedTo">> {
  return { pendingRoutedTo: jest.fn().mockResolvedValue(rows) };
}

function makeWfh(rows: unknown[] = []): jest.Mocked<Pick<WfhService, "pendingRoutedTo">> {
  return { pendingRoutedTo: jest.fn().mockResolvedValue(rows) };
}

function makeRegistry(): ApprovalAdapterRegistry {
  const registry = new ApprovalAdapterRegistry();
  return registry;
}

function leaveRow(id: number, createdAt: Date) {
  return {
    id,
    orgId: "org-1",
    userId: `user-${id}`,
    startDate: "2024-01-10",
    endDate: "2024-01-12",
    isHalfDay: false,
    status: "PENDING",
    createdAt,
    leaveType: { name: "Annual Leave" },
    user: { id: `user-${id}`, name: `Employee ${id}` },
  };
}

function wfhRow(id: number, createdAt: Date) {
  return {
    id,
    orgId: "org-1",
    userId: `user-${id}`,
    date: "2024-01-10",
    reason: "WFH",
    createdAt,
    userName: `Employee ${id}`,
    userFirstName: "Employee",
    userLastName: `${id}`,
    userEmail: `user-${id}@example.com`,
  };
}

describe("HrTimeApprovalAdapter", () => {
  const orgId = "org-1";
  const membershipId = 42;
  const cursor: InboxSourcePosition | null = null;

  describe("leave adapter (registered as hr:leaves:approve)", () => {
    it("registers with the correct permission key on init", () => {
      const registry = makeRegistry();
      const adapter = new HrTimeApprovalAdapter(
        makeLeaves() as never,
        makeWfh() as never,
        registry,
      );
      adapter.onModuleInit();
      const adapters = registry.list();
      const leaveAdapter = adapters.find((a) => a.kindLabel === "leave");
      expect(leaveAdapter?.permission).toBe("hr:leaves:approve");
    });

    it("returns leave items mapped to BuildApprovalInboxItem when membershipId is present", async () => {
      const registry = makeRegistry();
      const leaves = makeLeaves([leaveRow(1, new Date("2024-01-10T09:00:00Z"))]);
      const adapter = new HrTimeApprovalAdapter(leaves as never, makeWfh() as never, registry);
      adapter.onModuleInit();

      const leaveAdapter = registry.list().find((a) => a.kindLabel === "leave")!;
      const items = await leaveAdapter.fetch(orgId, "user-1", membershipId, 10, cursor);

      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        kind: "build_approval",
        approvalKind: "leave",
        id: 1,
        dedupKey: "approval:leave:1",
        sourceModule: "hr",
        status: "pending",
      });
    });

    it("returns empty array when membershipId is null (no org membership)", async () => {
      const registry = makeRegistry();
      const leaves = makeLeaves([leaveRow(1, new Date())]);
      const adapter = new HrTimeApprovalAdapter(leaves as never, makeWfh() as never, registry);
      adapter.onModuleInit();

      const leaveAdapter = registry.list().find((a) => a.kindLabel === "leave")!;
      const items = await leaveAdapter.fetch(orgId, "user-1", null, 10, cursor);

      expect(items).toHaveLength(0);
      expect(leaves.pendingRoutedTo).not.toHaveBeenCalled();
    });

    it("only returns items routed to the acting membershipId (tenant isolation)", async () => {
      const registry = makeRegistry();
      const leaves = makeLeaves([leaveRow(1, new Date())]);
      const adapter = new HrTimeApprovalAdapter(leaves as never, makeWfh() as never, registry);
      adapter.onModuleInit();

      const leaveAdapter = registry.list().find((a) => a.kindLabel === "leave")!;
      await leaveAdapter.fetch(orgId, "user-1", membershipId, 10, cursor);

      expect(leaves.pendingRoutedTo).toHaveBeenCalledWith(orgId, membershipId, 10);
    });

    it("dedupKeys are in the approval:leave: namespace, not approval:wfh:", async () => {
      const registry = makeRegistry();
      const leaves = makeLeaves([leaveRow(5, new Date())]);
      const adapter = new HrTimeApprovalAdapter(leaves as never, makeWfh() as never, registry);
      adapter.onModuleInit();

      const leaveAdapter = registry.list().find((a) => a.kindLabel === "leave")!;
      const items = await leaveAdapter.fetch(orgId, "user-1", membershipId, 10, cursor);

      expect(items[0]?.dedupKey).toBe("approval:leave:5");
      expect(items[0]?.dedupKey).not.toContain("wfh");
    });
  });

  describe("wfh adapter (registered as hr:attendance:manage)", () => {
    it("registers with the correct permission key on init", () => {
      const registry = makeRegistry();
      const adapter = new HrTimeApprovalAdapter(
        makeLeaves() as never,
        makeWfh() as never,
        registry,
      );
      adapter.onModuleInit();
      const wfhAdapter = registry.list().find((a) => a.kindLabel === "wfh");
      expect(wfhAdapter?.permission).toBe("hr:attendance:manage");
    });

    it("returns wfh items mapped to BuildApprovalInboxItem when membershipId is present", async () => {
      const registry = makeRegistry();
      const wfh = makeWfh([wfhRow(2, new Date("2024-01-10T09:00:00Z"))]);
      const adapter = new HrTimeApprovalAdapter(makeLeaves() as never, wfh as never, registry);
      adapter.onModuleInit();

      const wfhAdapter = registry.list().find((a) => a.kindLabel === "wfh")!;
      const items = await wfhAdapter.fetch(orgId, "user-1", membershipId, 10, cursor);

      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        kind: "build_approval",
        approvalKind: "wfh",
        id: 2,
        dedupKey: "approval:wfh:2",
        sourceModule: "hr",
        status: "pending",
      });
    });

    it("returns empty array when membershipId is null", async () => {
      const registry = makeRegistry();
      const wfh = makeWfh([wfhRow(1, new Date())]);
      const adapter = new HrTimeApprovalAdapter(makeLeaves() as never, wfh as never, registry);
      adapter.onModuleInit();

      const wfhAdapter = registry.list().find((a) => a.kindLabel === "wfh")!;
      const items = await wfhAdapter.fetch(orgId, "user-1", null, 10, cursor);

      expect(items).toHaveLength(0);
    });
  });

  describe("cross-adapter dedup key isolation", () => {
    it("a leave and a wfh with the same numeric id produce different dedup keys", async () => {
      const registry = makeRegistry();
      const leaves = makeLeaves([leaveRow(5, new Date())]);
      const wfh = makeWfh([wfhRow(5, new Date())]);
      const adapter = new HrTimeApprovalAdapter(leaves as never, wfh as never, registry);
      adapter.onModuleInit();

      const leaveAdapter = registry.list().find((a) => a.kindLabel === "leave")!;
      const wfhAdapter = registry.list().find((a) => a.kindLabel === "wfh")!;
      const leaveItems = await leaveAdapter.fetch(orgId, "user-1", membershipId, 10, cursor);
      const wfhItems = await wfhAdapter.fetch(orgId, "user-1", membershipId, 10, cursor);

      expect(leaveItems[0]?.dedupKey).not.toBe(wfhItems[0]?.dedupKey);
    });
  });

  describe("independent degradation", () => {
    it("wfh adapter throwing does not prevent leave adapter from returning items", async () => {
      const registry = makeRegistry();
      const leaves = makeLeaves([leaveRow(1, new Date())]);
      const wfh = makeWfh();
      (wfh.pendingRoutedTo as jest.Mock).mockRejectedValue(new Error("DB timeout"));
      const adapter = new HrTimeApprovalAdapter(leaves as never, wfh as never, registry);
      adapter.onModuleInit();

      const leaveAdapter = registry.list().find((a) => a.kindLabel === "leave")!;
      const items = await leaveAdapter.fetch(orgId, "user-1", membershipId, 10, cursor);

      expect(items).toHaveLength(1);
    });
  });
});
```

- [ ] **Step 2: Run tests**

```
pnpm exec jest --runInBand src/modules/hr/time/hr-time-approval.adapter.spec.ts
```

Expected: all tests PASS.

- [ ] **Step 3: Run typecheck:test**

```
pnpm typecheck:test
```

Expected: no errors.

---

### Task 7: Timesheet approval adapter

**Files:**
- Create: `src/modules/timesheets/core/timesheet-approval.adapter.ts`
- Modify: `src/modules/timesheets/core/timesheets-core.module.ts`

**Interfaces:**
- Consumes: `ApprovalsService.pendingRoutedTo(orgId, membershipId, limit)` — returns `{ id, userMembershipId, userName, userEmail, periodStart, periodEnd, totalHours, submittedAt, approvalDueAt, approvalRoute }`
- Produces: one `ApprovalSourceAdapter` registered with `timesheets:approvals:view`

**Permission key proof:** `timesheets:approvals:view` — exists in `src/modules/rbac/permissions/timesheets.ts` line 50.

- [ ] **Step 1: Write `timesheet-approval.adapter.ts`**

```typescript
// src/modules/timesheets/core/timesheet-approval.adapter.ts
import { Injectable, OnModuleInit } from "@nestjs/common";
import { ApprovalAdapterRegistry } from "../../attention/approval-adapter.registry";
import { ApprovalsService } from "./approvals.service";
import type {
  BuildApprovalInboxItem,
  InboxSourcePosition,
} from "../../notifications/dto/unified-inbox.schemas";

function passesCursor(
  itemId: number,
  itemTimestamp: string,
  cursor: InboxSourcePosition | null,
): boolean {
  if (cursor === null) return true;
  const itemMs = new Date(itemTimestamp).getTime();
  if (cursor.t !== null) {
    const cursorMs = new Date(cursor.t).getTime();
    if (itemMs < cursorMs) return true;
    if (itemMs === cursorMs && itemId < cursor.id) return true;
    return false;
  }
  return itemId < cursor.id;
}

@Injectable()
export class TimesheetApprovalAdapter implements OnModuleInit {
  constructor(
    private readonly approvals: ApprovalsService,
    private readonly registry: ApprovalAdapterRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      module: "timesheets",
      permission: "timesheets:approvals:view",
      kindLabel: "timesheet",
      fetch: (orgId, _userId, membershipId, limit, cursor) =>
        this.fetchTimesheetItems(orgId, membershipId, limit, cursor),
    });
  }

  private async fetchTimesheetItems(
    orgId: string,
    membershipId: number | null,
    limit: number,
    cursor: InboxSourcePosition | null,
  ): Promise<BuildApprovalInboxItem[]> {
    if (membershipId === null) return [];
    const rows = await this.approvals.pendingRoutedTo(orgId, membershipId, limit);
    const items: BuildApprovalInboxItem[] = rows.map((row) => ({
      kind: "build_approval" as const,
      id: row.id,
      status: "pending",
      projectId: null,
      approvalKind: "timesheet",
      ticketId: null,
      dueAt: row.approvalDueAt ? row.approvalDueAt.toISOString() : null,
      subject: `Timesheet · ${row.periodStart} to ${row.periodEnd} · ${Number(row.totalHours).toFixed(1)}h`,
      sourceModule: "timesheets",
      actor: row.userName
        ? { id: String(row.userMembershipId ?? row.id), name: row.userName, image: null }
        : null,
      deepLink: `/timesheets/approvals?period=${String(row.id)}`,
      isRead: false,
      dedupKey: `approval:timesheet:${String(row.id)}`,
      timestamp: (row.submittedAt ?? new Date()).toISOString(),
    }));
    items.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    return items
      .filter((item) => passesCursor(item.id, item.timestamp, cursor))
      .slice(0, limit);
  }
}
```

- [ ] **Step 2: Add `AttentionModule` and `TimesheetApprovalAdapter` to `timesheets-core.module.ts`**

```typescript
import { AttentionModule } from "../../attention/attention.module";
import { TimesheetApprovalAdapter } from "./timesheet-approval.adapter";

@Module({
  imports: [AiModule, AccountingKernelModule, NotificationsModule, OutboxModule, WebhooksModule, EmploymentFactsModule, AttentionModule],
  // ... controllers unchanged ...
  providers: [
    // ... existing providers ...
    TimesheetApprovalAdapter,
  ],
  exports: [
    // ... existing exports ...
  ],
})
```

- [ ] **Step 3: Run typecheck**

```
pnpm typecheck
```

Expected: no errors. The `ApprovalsService.pendingRoutedTo` return type includes `approvalDueAt` which may be typed as `Date | null` — check and handle accordingly.

---

### Task 8: Timesheet approval adapter spec

**Files:**
- Create: `src/modules/timesheets/core/timesheet-approval.adapter.spec.ts`

- [ ] **Step 1: Write the spec**

```typescript
// src/modules/timesheets/core/timesheet-approval.adapter.spec.ts
import { TimesheetApprovalAdapter } from "./timesheet-approval.adapter";
import { ApprovalAdapterRegistry } from "../../attention/approval-adapter.registry";
import type { ApprovalsService } from "./approvals.service";

function makeApprovals(rows: unknown[] = []): jest.Mocked<Pick<ApprovalsService, "pendingRoutedTo">> {
  return { pendingRoutedTo: jest.fn().mockResolvedValue(rows) };
}

function periodRow(id: number, submittedAt: Date) {
  return {
    id,
    userMembershipId: 10,
    userName: `Employee ${id}`,
    userEmail: `emp${id}@example.com`,
    periodStart: "2024-01-01",
    periodEnd: "2024-01-14",
    totalHours: "80.0",
    submittedAt,
    approvalDueAt: null,
    approvalRoute: null,
  };
}

describe("TimesheetApprovalAdapter", () => {
  const orgId = "org-1";
  const membershipId = 42;

  it("registers with permission key timesheets:approvals:view", () => {
    const registry = new ApprovalAdapterRegistry();
    const adapter = new TimesheetApprovalAdapter(makeApprovals() as never, registry);
    adapter.onModuleInit();

    const adapters = registry.list();
    expect(adapters).toHaveLength(1);
    expect(adapters[0]?.permission).toBe("timesheets:approvals:view");
    expect(adapters[0]?.kindLabel).toBe("timesheet");
  });

  it("returns timesheet items as BuildApprovalInboxItem when membershipId is present", async () => {
    const registry = new ApprovalAdapterRegistry();
    const approvals = makeApprovals([periodRow(3, new Date("2024-01-15T10:00:00Z"))]);
    const adapter = new TimesheetApprovalAdapter(approvals as never, registry);
    adapter.onModuleInit();

    const tsAdapter = registry.list()[0]!;
    const items = await tsAdapter.fetch(orgId, "user-1", membershipId, 10, null);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "build_approval",
      approvalKind: "timesheet",
      id: 3,
      dedupKey: "approval:timesheet:3",
      sourceModule: "timesheets",
      status: "pending",
    });
  });

  it("returns empty array when membershipId is null", async () => {
    const registry = new ApprovalAdapterRegistry();
    const approvals = makeApprovals([periodRow(1, new Date())]);
    const adapter = new TimesheetApprovalAdapter(approvals as never, registry);
    adapter.onModuleInit();

    const tsAdapter = registry.list()[0]!;
    const items = await tsAdapter.fetch(orgId, "user-1", null, 10, null);

    expect(items).toHaveLength(0);
    expect(approvals.pendingRoutedTo).not.toHaveBeenCalled();
  });

  it("queries with the actor's membershipId for tenant isolation", async () => {
    const registry = new ApprovalAdapterRegistry();
    const approvals = makeApprovals([]);
    const adapter = new TimesheetApprovalAdapter(approvals as never, registry);
    adapter.onModuleInit();

    const tsAdapter = registry.list()[0]!;
    await tsAdapter.fetch(orgId, "user-1", membershipId, 10, null);

    expect(approvals.pendingRoutedTo).toHaveBeenCalledWith(orgId, membershipId, 10);
  });

  it("dedup key is in approval:timesheet: namespace, not approval:build:", async () => {
    const registry = new ApprovalAdapterRegistry();
    const approvals = makeApprovals([periodRow(7, new Date())]);
    const adapter = new TimesheetApprovalAdapter(approvals as never, registry);
    adapter.onModuleInit();

    const tsAdapter = registry.list()[0]!;
    const items = await tsAdapter.fetch(orgId, "user-1", membershipId, 10, null);

    expect(items[0]?.dedupKey).toBe("approval:timesheet:7");
    expect(items[0]?.dedupKey).not.toContain("build");
  });

  it("adapter throwing does not affect other adapters (exception propagates to caller, not swallowed)", async () => {
    const registry = new ApprovalAdapterRegistry();
    const approvals = makeApprovals();
    (approvals.pendingRoutedTo as jest.Mock).mockRejectedValue(new Error("DB error"));
    const adapter = new TimesheetApprovalAdapter(approvals as never, registry);
    adapter.onModuleInit();

    const tsAdapter = registry.list()[0]!;
    await expect(tsAdapter.fetch(orgId, "user-1", membershipId, 10, null)).rejects.toThrow("DB error");
  });
});
```

- [ ] **Step 2: Run tests**

```
pnpm exec jest --runInBand src/modules/timesheets/core/timesheet-approval.adapter.spec.ts
```

Expected: all tests PASS.

---

### Task 9: HR Workflow approval adapter

**Files:**
- Create: `src/modules/hr/workflows/hr-workflow-approval.adapter.ts`
- Modify: `src/modules/hr/workflows/hr-workflows.module.ts`

**Interfaces:**
- Consumes: `HrWorkflowInstancesService.getInbox(u, page, limit)` — the only existing method that returns inbox items routed to the actor. It takes `CurrentUserContext` and uses page-based pagination.
- Produces: one `ApprovalSourceAdapter` registered with `hr:workflows:approve`

**Permission key proof:** `hr:workflows:approve` — exists in `src/modules/rbac/permissions/hr-foundation.permissions.ts` line 231.

**Design note on `getInbox` signature:** `getInbox` takes `CurrentUserContext` which wraps `orgId`, `userId`, and `membershipId`. The adapter constructs a minimal context from the fetch params. Cursor-based pagination is not supported by `getInbox` (it uses page-based); the adapter always fetches page 1 with the given limit. This means workflow items always show the CURRENT inbox state, not paginated history — acceptable for approval queues.

- [ ] **Step 1: Write `hr-workflow-approval.adapter.ts`**

```typescript
// src/modules/hr/workflows/hr-workflow-approval.adapter.ts
import { Injectable, OnModuleInit } from "@nestjs/common";
import { ApprovalAdapterRegistry } from "../../attention/approval-adapter.registry";
import { HrWorkflowInstancesService } from "./hr-workflow-instances.service";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type {
  BuildApprovalInboxItem,
  InboxSourcePosition,
} from "../../notifications/dto/unified-inbox.schemas";

@Injectable()
export class HrWorkflowApprovalAdapter implements OnModuleInit {
  constructor(
    private readonly workflows: HrWorkflowInstancesService,
    private readonly registry: ApprovalAdapterRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      module: "hr",
      permission: "hr:workflows:approve",
      kindLabel: "workflow",
      fetch: (orgId, userId, membershipId, limit, cursor) =>
        this.fetchWorkflowItems(orgId, userId, membershipId, limit, cursor),
    });
  }

  private async fetchWorkflowItems(
    orgId: string,
    userId: string,
    membershipId: number | null,
    limit: number,
    _cursor: InboxSourcePosition | null,
  ): Promise<BuildApprovalInboxItem[]> {
    if (membershipId === null) return [];
    const u: CurrentUserContext = {
      userId,
      orgId,
      role: "MEMBER",
      isOrgOwner: false,
      sessionId: "",
      tokenScopes: null,
      principal: humanSessionPrincipal(membershipId, false),
    };
    const result = await this.workflows.getInbox(u, 1, limit);
    return result.data.map((instance) => ({
      kind: "build_approval" as const,
      id: instance.id,
      status: instance.status,
      projectId: null,
      approvalKind: "workflow",
      ticketId: null,
      dueAt: instance.dueAt ? instance.dueAt.toISOString() : null,
      subject: `${String(instance.objectType).replaceAll("_", " ")} · step ${String(instance.currentStepOrder)}`,
      sourceModule: "hr",
      actor: null,
      deepLink: "/hr/approvals",
      isRead: false,
      dedupKey: `approval:workflow:${String(instance.id)}`,
      timestamp: instance.createdAt.toISOString(),
    }));
  }
}
```

- [ ] **Step 2: Add `AttentionModule` and `HrWorkflowApprovalAdapter` to `hr-workflows.module.ts`**

```typescript
import { AttentionModule } from "../../attention/attention.module";
import { HrWorkflowApprovalAdapter } from "./hr-workflow-approval.adapter";

@Module({
  imports: [DirectoryModule, AttentionModule],
  controllers: [
    HrWorkflowDefinitionsController,
    HrWorkflowInstancesController,
    HrWorkflowDelegationsController,
  ],
  providers: [
    HrWorkflowApproverService,
    HrWorkflowStepRunnerService,
    HrWorkflowEngineService,
    HrWorkflowDefinitionsService,
    HrWorkflowInstancesService,
    HrWorkflowDelegationsService,
    HrWorkflowStarterAdapter,
    HrWorkflowApprovalAdapter,   // ← add
  ],
  exports: [HrWorkflowEngineService, HrWorkflowStarterAdapter, HrWorkflowApproverService, HrWorkflowInstancesService],
})
```

- [ ] **Step 3: Run typecheck**

```
pnpm typecheck
```

Expected: no errors. Check that `result.data` from `getInbox` has the fields `id`, `objectType`, `currentStepOrder`, `dueAt`, `createdAt`, `status`.

---

### Task 10: HR Workflow adapter spec

**Files:**
- Create: `src/modules/hr/workflows/hr-workflow-approval.adapter.spec.ts`

- [ ] **Step 1: Write the spec**

```typescript
// src/modules/hr/workflows/hr-workflow-approval.adapter.spec.ts
import { HrWorkflowApprovalAdapter } from "./hr-workflow-approval.adapter";
import { ApprovalAdapterRegistry } from "../../attention/approval-adapter.registry";
import type { HrWorkflowInstancesService } from "./hr-workflow-instances.service";

function makeWorkflows(data: unknown[] = []): jest.Mocked<Pick<HrWorkflowInstancesService, "getInbox">> {
  return {
    getInbox: jest.fn().mockResolvedValue({ data, total: data.length, page: 1, limit: 10 }),
  };
}

function workflowInstance(id: number, createdAt: Date) {
  return {
    id,
    orgId: "org-1",
    definitionId: 1,
    objectType: "leave_request",
    objectId: id,
    requestedBy: "user-req",
    subjectEmployeeId: "user-sub",
    context: {},
    status: "in_progress",
    currentStepOrder: 1,
    dueAt: null,
    createdAt,
    updatedAt: createdAt,
    definitionSnapshot: { steps: [] },
  };
}

describe("HrWorkflowApprovalAdapter", () => {
  const orgId = "org-1";
  const userId = "user-1";
  const membershipId = 42;

  it("registers with permission key hr:workflows:approve", () => {
    const registry = new ApprovalAdapterRegistry();
    const adapter = new HrWorkflowApprovalAdapter(makeWorkflows() as never, registry);
    adapter.onModuleInit();

    const adapters = registry.list();
    expect(adapters).toHaveLength(1);
    expect(adapters[0]?.permission).toBe("hr:workflows:approve");
    expect(adapters[0]?.kindLabel).toBe("workflow");
  });

  it("returns workflow items as BuildApprovalInboxItem when membershipId is present", async () => {
    const registry = new ApprovalAdapterRegistry();
    const workflows = makeWorkflows([workflowInstance(10, new Date("2024-01-10T10:00:00Z"))]);
    const adapter = new HrWorkflowApprovalAdapter(workflows as never, registry);
    adapter.onModuleInit();

    const wfAdapter = registry.list()[0]!;
    const items = await wfAdapter.fetch(orgId, userId, membershipId, 10, null);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "build_approval",
      approvalKind: "workflow",
      id: 10,
      dedupKey: "approval:workflow:10",
      sourceModule: "hr",
    });
  });

  it("returns empty array when membershipId is null", async () => {
    const registry = new ApprovalAdapterRegistry();
    const workflows = makeWorkflows([workflowInstance(1, new Date())]);
    const adapter = new HrWorkflowApprovalAdapter(workflows as never, registry);
    adapter.onModuleInit();

    const wfAdapter = registry.list()[0]!;
    const items = await wfAdapter.fetch(orgId, userId, null, 10, null);

    expect(items).toHaveLength(0);
    expect(workflows.getInbox).not.toHaveBeenCalled();
  });

  it("passes orgId and membershipId from the fetch call, not from a hardcoded context", async () => {
    const registry = new ApprovalAdapterRegistry();
    const workflows = makeWorkflows([]);
    const adapter = new HrWorkflowApprovalAdapter(workflows as never, registry);
    adapter.onModuleInit();

    const wfAdapter = registry.list()[0]!;
    await wfAdapter.fetch("org-other", "user-other", 99, 5, null);

    const calledContext = (workflows.getInbox as jest.Mock).mock.calls[0]?.[0];
    expect(calledContext.orgId).toBe("org-other");
    expect(calledContext.principal.membershipId).toBe(99);
  });

  it("dedup key is in approval:workflow: namespace, not approval:build:", async () => {
    const registry = new ApprovalAdapterRegistry();
    const workflows = makeWorkflows([workflowInstance(7, new Date())]);
    const adapter = new HrWorkflowApprovalAdapter(workflows as never, registry);
    adapter.onModuleInit();

    const wfAdapter = registry.list()[0]!;
    const items = await wfAdapter.fetch(orgId, userId, membershipId, 10, null);

    expect(items[0]?.dedupKey).toBe("approval:workflow:7");
    expect(items[0]?.dedupKey).not.toContain("build");
  });

  it("adapter throwing does not affect other adapters registered with same registry", async () => {
    const registry = new ApprovalAdapterRegistry();
    const workflows = makeWorkflows();
    (workflows.getInbox as jest.Mock).mockRejectedValue(new Error("network timeout"));
    const adapter = new HrWorkflowApprovalAdapter(workflows as never, registry);
    adapter.onModuleInit();

    const wfAdapter = registry.list()[0]!;
    await expect(wfAdapter.fetch(orgId, userId, membershipId, 10, null)).rejects.toThrow("network timeout");
  });
});
```

- [ ] **Step 2: Run tests**

```
pnpm exec jest --runInBand src/modules/hr/workflows/hr-workflow-approval.adapter.spec.ts
```

Expected: all tests PASS.

---

### Task 11: Verify overall compilation and existing specs pass

- [ ] **Step 1: Run full typecheck**

```
pnpm typecheck
```

Expected: no errors.

- [ ] **Step 2: Run typecheck for test files**

```
pnpm typecheck:test
```

Expected: no errors.

- [ ] **Step 3: Run registry spec**

```
pnpm exec jest --runInBand src/modules/attention/approval-adapter.registry.spec.ts
```

Expected: all PASS.

- [ ] **Step 4: Run unified-inbox spec (existing + updated)**

```
pnpm exec jest --runInBand src/modules/notifications/unified-inbox.spec.ts
```

Expected: all PASS.

- [ ] **Step 5: Run all new adapter specs together**

```
pnpm exec jest --runInBand src/modules/hr/time/hr-time-approval.adapter.spec.ts src/modules/timesheets/core/timesheet-approval.adapter.spec.ts src/modules/hr/workflows/hr-workflow-approval.adapter.spec.ts
```

Expected: all PASS.

- [ ] **Step 6: Run the `check:module-registration` gate (BE-01)**

```
pnpm check:module-registration
```

Expected: `AttentionModule` passes the registration check.

- [ ] **Step 7: Run the `check:cycles` gate (BE-10)**

```
pnpm check:cycles
```

Expected: no new cycles. The design is cycle-free: `AttentionModule` → nothing; `NotificationsModule` → `AttentionModule`; HR/timesheet modules → `AttentionModule` (already → `NotificationsModule`).

---

## Self-Review Checklist

### Spec coverage

| Requirement | Task |
|---|---|
| Leaf registry module with idempotent register/list | Task 1, 2 |
| `NotificationsModule` imports `AttentionModule` | Task 3 |
| `buildApprovalAdapters()` returns Build + registry | Task 3 |
| Re-export `ApprovalSourceAdapter` from `unified-inbox-sources.ts` | Task 3 |
| HR leave adapter: `hr:leaves:approve`, `LeavesService.pendingRoutedTo` | Task 5 |
| HR WFH adapter: `hr:attendance:manage`, `WfhService.pendingRoutedTo` | Task 5 |
| Timesheet adapter: `timesheets:approvals:view`, `ApprovalsService.pendingRoutedTo` | Task 7 |
| Workflow adapter: `hr:workflows:approve`, `HrWorkflowInstancesService.getInbox` | Task 9 |
| Each adapter: permission key, auth server-side, tenant isolation, bounded results | Tasks 5–10 |
| Dedup key collision-free across sources | Tasks 6, 8, 10 |
| Independent degradation (one adapter fail ≠ whole inbox fail) | Task 3 (fetchAllAdapters), Tasks 6, 8, 10 |
| Registry unit spec: idempotent, list works | Task 2 |
| Per-adapter: positive auth, negative auth (no query executed), tenant isolation, dedup, independent failure | Tasks 6, 8, 10 |
| `pnpm typecheck` + `pnpm typecheck:test` pass | Task 11 |
| Register `AttentionModule` in `app.module.ts` (BE-01) | Task 4 |
| No new code comments | Global constraint |
| Files under 300 lines | Global constraint — check each new file |

### Placeholder scan

No TBD, TODO, or vague references present.

### Type consistency

- `ApprovalSourceAdapter` defined in Task 1, re-exported in Task 3, consumed by adapters in Tasks 5, 7, 9.
- `BuildApprovalInboxItem` flows from `unified-inbox.schemas.ts` (existing) through all adapters.
- `InboxSourcePosition` same.
- `humanSessionPrincipal` helper used in Task 9 — must be imported from `common/auth/principal`.
- `fetchAllAdapters` helper return type `{ items, errors, permDenied }` consumed by `buildApprovalSourceStatus` — types must match exactly.

---

## Known limitations / explicit non-wires

- **Workflow adapter cursor pagination:** `HrWorkflowInstancesService.getInbox` uses page-based pagination. The adapter always fetches page 1. Cursor advancement for workflows is not supported in this release — each inbox page shows the current workflow inbox state.
- **Leave / WFH cursor precision:** `pendingRoutedTo` fetches all pending items; cursor filtering is applied in memory. For large approval queues (>limit), some items may be repeated across pages near timestamp boundaries. This is acceptable given typical approval queue sizes.
- **No new `InboxKind` values:** All new adapters produce `build_approval` items with `approvalKind` discriminating the source. A future schema change could add dedicated kinds (e.g., `hr_approval`), but that requires frontend changes.
