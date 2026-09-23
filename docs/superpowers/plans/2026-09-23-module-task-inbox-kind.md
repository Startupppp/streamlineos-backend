# `module_task` Inbox Kind Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fifth unified-inbox kind (`module_task`) plus an `AttentionAdapterRegistry`, and ship two real adapters — CRM follow-up activities and support tickets assigned to the caller — so assigned work that is not an approval appears in the inbox and badge count.

**Architecture:** `AttentionAdapterRegistry` mirrors `ApprovalAdapterRegistry` but returns `ModuleTaskInboxItem[]`. Two adapters (`CrmAttentionAdapter`, `SupportAttentionAdapter`) self-register via `OnModuleInit` in their own modules, which are imported into `CrmRootModule` and `SupportRootModule` respectively. `UnifiedInboxService` gains a parallel fetch+count path for task adapters, and the cursor state gains an `mt` field identical to the existing `ap` field for approval adapters.

**Tech Stack:** NestJS 11.1, TypeScript 5.6 strict, Drizzle 0.45, Zod 4, Jest

**Spec:** The task prompt in the session that launched this plan (no separate spec file).

## Global Constraints

- No `any`, no `as X`, no `@ts-ignore` — hard zero (BE-10 Non-negotiable #10).
- Every new service uses `@Inject(DRIZZLE)` for DB access, never `this.db` in a controller (BE-06).
- Explicit column projections — never `select()` with no arguments for inbox reads (BE-07).
- Lead every composite predicate with the tenant column (BE-44).
- Permission keys must exist in BOTH the backend catalog (`src/modules/rbac/permissions/`) AND the frontend catalog (`contracts/permission-catalog.json`) before use (BE-112). The two keys chosen here — `crm:activities:view` and `support:tickets:view` — already exist in both catalogs; do not invent new ones.
- `module_task` is only included when `triage === "active"` (same rule as `build_approval` and `broadcast`).
- **BANNED git commands:** `stash`, `checkout`, `restore`, `reset`, `clean`, `commit`, `revert`, `merge`, `rebase`, `pull`, `push`, `worktree`, `branch -D`. Read-only git (log, status, diff) is fine.

---

## File Map

### Created
| File | Responsibility |
|---|---|
| `src/modules/attention/attention-adapter.registry.ts` | `AttentionSourceAdapter` type, `attentionAdapterKey`, `AttentionAdapterRegistry` |
| `src/modules/attention/attention-adapter.registry.spec.ts` | Registry unit tests |
| `src/modules/crm/crm-attention-adapter.ts` | CRM activities open-task adapter |
| `src/modules/crm/crm-attention-adapter.spec.ts` | CRM adapter unit tests |
| `src/modules/crm/crm-attention.module.ts` | NestJS module for the CRM adapter |
| `src/modules/support/support-attention-adapter.ts` | Support ticket adapter |
| `src/modules/support/support-attention-adapter.spec.ts` | Support adapter unit tests |
| `src/modules/support/support-attention.module.ts` | NestJS module for the support adapter |

### Modified
| File | Change summary |
|---|---|
| `src/modules/notifications/dto/unified-inbox.schemas.ts` | Add `module_task` kind, `moduleTaskInboxItemSchema`, `task` count field, `mt` cursor field |
| `src/modules/notifications/unified-inbox-projections.ts` | `KIND_ORDER` rank 4, generalize `lastDeliveredAdapterPositions` |
| `src/modules/notifications/unified-inbox.service.ts` | Wire `AttentionAdapterRegistry`, add task fetch/count/source-status paths, update cursor |
| `src/modules/notifications/unified-inbox-adapter-cursor-state.spec.ts` | Add `mt: {}` to one direct `InboxCursorState` literal, add `mt` cursor tests |
| `src/modules/attention/attention.module.ts` | Add `AttentionAdapterRegistry` to providers + exports |
| `src/modules/crm/crm.module.ts` | Import `CrmAttentionModule` |
| `src/modules/support/support.module.ts` | Import `SupportAttentionModule` |
| Every spec file that calls `new UnifiedInboxService(...)` directly (≈12 files) | Add 7th arg: `new AttentionAdapterRegistry()` |

---

## Task 1: Extend `unified-inbox.schemas.ts`

**Files:**
- Modify: `src/modules/notifications/dto/unified-inbox.schemas.ts`
- Modify: `src/modules/notifications/unified-inbox-adapter-cursor-state.spec.ts`

**Interfaces:**
- Produces: `INBOX_KINDS` now contains `"module_task"`, `moduleTaskInboxItemSchema`, `ModuleTaskInboxItem`, updated `unifiedCountResponseSchema`, updated `InboxCursorState` (with `mt`), updated `encodeInboxCursor`/`decodeInboxCursor`/`sameInboxCursorState`

- [ ] **Step 1.1: Write failing tests for `mt` cursor handling**

Add to `unified-inbox-adapter-cursor-state.spec.ts`, after the existing `ap` test block:

```ts
describe("unified inbox cursor — per-adapter task positions (mt)", () => {
  it("a cursor minted before `mt` existed decodes to an empty task map without throwing", () => {
    const state = decodeInboxCursor(encodeRaw(LEGACY_PAYLOAD));
    expect(state.mt).toEqual({});
    expect(state.n).toBe(10);
  });

  it("a cursor carrying `mt` decodes every well-formed entry", () => {
    const state = decodeInboxCursor(
      encodeRaw({
        ...LEGACY_PAYLOAD,
        mt: {
          "crm:crm_task": { id: 0, t: "2026-09-18T00:00:00.000Z" },
          "support:support_ticket": { id: 42, t: null },
        },
      }),
    );
    expect(state.mt).toEqual({
      "crm:crm_task": { id: 0, t: "2026-09-18T00:00:00.000Z" },
      "support:support_ticket": { id: 42, t: null },
    });
  });

  it("round-trips the mt map through encode and decode", () => {
    const state: InboxCursorState = {
      n: null, nt: null, b: null, bt: null, m: null, a: null, at: null,
      ap: {},
      mt: { "support:support_ticket": { id: 7, t: "2026-09-18T00:00:00.000Z" } },
    };
    expect(decodeInboxCursor(encodeInboxCursor(state)).mt).toEqual(state.mt);
  });

  it("a moved mt position is an advance so the next cursor is emitted", () => {
    const before: InboxCursorState = decodeInboxCursor(encodeRaw(LEGACY_PAYLOAD));
    const after: InboxCursorState = {
      ...before,
      mt: { "support:support_ticket": { id: 7, t: "2026-09-18T00:00:00.000Z" } },
    };
    expect(sameInboxCursorState(before, after)).toBe(false);
    expect(sameInboxCursorState(after, after)).toBe(true);
  });
});
```

Also fix the existing literal `InboxCursorState` at line ~73 that will soon fail because `mt` is required:

```ts
// Line ~73: add mt: {} to the existing InboxCursorState literal
const state: InboxCursorState = {
  n: null, nt: null, b: null, bt: null, m: null, a: null, at: null,
  ap: {
    "hr:leave": { id: 7, t: "2026-09-18T00:00:00.000Z" },
    "timesheets:timesheet": { id: 88, t: "2026-09-17T00:00:00.000Z" },
  },
  mt: {},
};
```

- [ ] **Step 1.2: Run to confirm failures**

```
node --max-old-space-size=10240 ./node_modules/typescript/bin/tsc --noEmit -p tsconfig.test.json
```

Expected: errors on missing `mt` property and on `INBOX_KINDS` not containing `"module_task"`.

- [ ] **Step 1.3: Implement the schema changes**

In `src/modules/notifications/dto/unified-inbox.schemas.ts`:

```ts
// 1. Add "module_task" to INBOX_KINDS
export const INBOX_KINDS = [
  "notification",
  "broadcast",
  "mail",
  "build_approval",
  "module_task",
] as const;

// 2. Add moduleTaskInboxItemSchema after buildApprovalInboxItemSchema
export const moduleTaskInboxItemSchema = z.object({
  kind: z.literal("module_task"),
  id: z.string(),
  taskKind: z.string(),
  status: z.string(),
  priority: z.string(),
  dueAt: z.string().nullable(),
  body: z.string(),
  ...inboxItemBaseFields,
});

// 3. Update the discriminated union
export const unifiedInboxItemSchema = z.discriminatedUnion("kind", [
  notificationInboxItemSchema,
  broadcastInboxItemSchema,
  mailInboxItemSchema,
  buildApprovalInboxItemSchema,
  moduleTaskInboxItemSchema,
]);

// 4. Add ModuleTaskInboxItem type
export type ModuleTaskInboxItem = z.infer<typeof moduleTaskInboxItemSchema>;

// 5. Update unifiedCountResponseSchema
export const unifiedCountResponseSchema = z.object({
  notification: z.number().int(),
  mail: z.number().int(),
  approval: z.number().int(),
  task: z.number().int(),
  total: z.number().int(),
  mailExact: z.boolean(),
});

// 6. Add mt to InboxCursorState
export type InboxCursorState = {
  n: number | null;
  nt: string | null;
  b: number | null;
  bt: string | null;
  m: string | null;
  a: number | null;
  at: string | null;
  ap: Record<string, InboxSourcePosition>;
  mt: Record<string, InboxSourcePosition>;
};

// 7. Update EMPTY_CURSOR
const EMPTY_CURSOR: InboxCursorState = {
  n: null, nt: null, b: null, bt: null, m: null, a: null, at: null,
  ap: {},
  mt: {},
};

// emptyInboxCursor() already uses spread of EMPTY_CURSOR + { ap: {} }, update to also reset mt:
function emptyInboxCursor(): InboxCursorState {
  return { ...EMPTY_CURSOR, ap: {}, mt: {} };
}

// 8. Update encodeInboxCursor to include mt
export function encodeInboxCursor(state: InboxCursorState): string {
  const payload: InboxCursorState = {
    n: typeof state.n === "number" ? state.n : null,
    nt: typeof state.nt === "string" ? state.nt : null,
    b: typeof state.b === "number" ? state.b : null,
    bt: typeof state.bt === "string" ? state.bt : null,
    m: typeof state.m === "string" ? state.m : null,
    a: typeof state.a === "number" ? state.a : null,
    at: typeof state.at === "string" ? state.at : null,
    ap: decodeAdapterPositions(state.ap),
    mt: decodeAdapterPositions(state.mt),
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

// 9. Update decodeInboxCursor to include mt (defaulting to {} for old cursors)
export function decodeInboxCursor(
  cursor: string | undefined | null,
): InboxCursorState {
  if (typeof cursor !== "string" || cursor.length === 0)
    return emptyInboxCursor();
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainRecord(parsed)) return emptyInboxCursor();
    return {
      n: typeof parsed["n"] === "number" ? parsed["n"] : null,
      nt: typeof parsed["nt"] === "string" ? parsed["nt"] : null,
      b: typeof parsed["b"] === "number" ? parsed["b"] : null,
      bt: typeof parsed["bt"] === "string" ? parsed["bt"] : null,
      m: typeof parsed["m"] === "string" ? parsed["m"] : null,
      a: typeof parsed["a"] === "number" ? parsed["a"] : null,
      at: typeof parsed["at"] === "string" ? parsed["at"] : null,
      ap: decodeAdapterPositions(parsed["ap"]),
      mt: decodeAdapterPositions(parsed["mt"]),  // defaults to {} for old cursors
    };
  } catch {
    return emptyInboxCursor();
  }
}

// 10. Update sameInboxCursorState to compare mt
export function sameInboxCursorState(
  left: InboxCursorState,
  right: InboxCursorState,
): boolean {
  return (
    left.n === right.n &&
    left.nt === right.nt &&
    left.b === right.b &&
    left.bt === right.bt &&
    left.m === right.m &&
    left.a === right.a &&
    left.at === right.at &&
    sameAdapterPositions(left.ap, right.ap) &&
    sameAdapterPositions(left.mt, right.mt)
  );
}
```

- [ ] **Step 1.4: Run the cursor tests**

```
pnpm exec jest --ci --runInBand --testPathPattern="unified-inbox-adapter-cursor-state"
```

Expected: all existing `ap` tests pass, new `mt` tests pass.

---

## Task 2: Extend `unified-inbox-projections.ts`

**Files:**
- Modify: `src/modules/notifications/unified-inbox-projections.ts`

**Interfaces:**
- Consumes: `InboxKind` (updated to include `"module_task"`), `UnifiedInboxItem`
- Produces: `KIND_ORDER` with `module_task: 4`; `lastDeliveredAdapterPositions(page, current, adapterByDedupKey, trackedKind)` — 4-arg signature

- [ ] **Step 2.1: Add `module_task` rank to `KIND_ORDER`**

```ts
export const KIND_ORDER: Record<InboxKind, number> = {
  notification: 0,
  broadcast: 1,
  mail: 2,
  build_approval: 3,
  module_task: 4,
};
```

- [ ] **Step 2.2: Generalize `lastDeliveredAdapterPositions`**

Replace the existing implementation with the 4-argument version. The `trackedKind` parameter replaces the hardcoded `"build_approval"` check. For `module_task` items whose `id` is a string, parse it to a number; skip if not a safe integer (UUIDs from CRM parse to NaN and are skipped, which is correct since the CRM adapter sets `supportsAfterCursor: false`).

```ts
export function lastDeliveredAdapterPositions(
  page: UnifiedInboxItem[],
  current: Record<string, InboxSourcePosition>,
  adapterByDedupKey: ReadonlyMap<string, string>,
  trackedKind: InboxKind,
): Record<string, InboxSourcePosition> {
  const next: Record<string, InboxSourcePosition> = { ...current };
  for (const item of page) {
    if (item.kind !== trackedKind) continue;
    const adapterKey = adapterByDedupKey.get(item.dedupKey);
    if (adapterKey === undefined) continue;
    const numericId =
      typeof item.id === "number" ? item.id : Number(item.id);
    if (!Number.isSafeInteger(numericId)) continue;
    next[adapterKey] = { id: numericId, t: item.timestamp };
  }
  return next;
}
```

**Why this is safe for existing callers:** `build_approval` items always have a numeric `id`, so `typeof item.id === "number"` is always true for them. The `Number.isSafeInteger` guard is a no-op for numbers that are already safe integers. Behavior is identical to the old hardcoded version.

- [ ] **Step 2.3: Update the single call site in `unified-inbox.service.ts`**

Change the `ap` field in `nextState`:

```ts
ap: lastDeliveredAdapterPositions(
  page,
  cursorState.ap,
  adapterResult?.adapterByDedupKey ?? new Map<string, string>(),
  "build_approval",
),
```

(The `mt` field will be added in Task 6 once the attention registry exists.)

- [ ] **Step 2.4: Typecheck**

```
node --max-old-space-size=10240 ./node_modules/typescript/bin/tsc --noEmit -p tsconfig.build.json
```

Expected: passes (or the only errors are now in `unified-inbox.service.ts` about the missing 7th constructor arg — those are fixed in Task 6).

---

## Task 3: `AttentionAdapterRegistry` + update `AttentionModule`

**Files:**
- Create: `src/modules/attention/attention-adapter.registry.ts`
- Create: `src/modules/attention/attention-adapter.registry.spec.ts`
- Modify: `src/modules/attention/attention.module.ts`

**Interfaces:**
- Produces: `AttentionSourceAdapter` type, `attentionAdapterKey(adapter)`, `AttentionAdapterRegistry` class (injectable)

- [ ] **Step 3.1: Write the failing registry spec**

Create `src/modules/attention/attention-adapter.registry.spec.ts`:

```ts
import { AttentionAdapterRegistry } from "./attention-adapter.registry";
import type { AttentionSourceAdapter } from "./attention-adapter.registry";
import type {
  ModuleTaskInboxItem,
  InboxSourcePosition,
} from "../notifications/dto/unified-inbox.schemas";

function makeAdapter(
  module: string,
  kindLabel: string,
): AttentionSourceAdapter {
  return {
    module,
    kindLabel,
    permission: `${module}:test:view`,
    supportsAfterCursor: false,
    fetch: (): Promise<ModuleTaskInboxItem[]> => Promise.resolve([]),
    countPending: (): Promise<number> => Promise.resolve(0),
  };
}

function makeCursorAdapter(
  module: string,
  kindLabel: string,
): AttentionSourceAdapter {
  return {
    ...makeAdapter(module, kindLabel),
    supportsAfterCursor: true,
    fetch: (
      _orgId: string,
      _userId: string,
      _membershipId: number | null,
      _limit: number,
      cursor: InboxSourcePosition | null,
    ): Promise<ModuleTaskInboxItem[]> => {
      void cursor;
      return Promise.resolve([]);
    },
  };
}

describe("AttentionAdapterRegistry", () => {
  let registry: AttentionAdapterRegistry;

  beforeEach(() => {
    registry = new AttentionAdapterRegistry();
  });

  it("returns empty list before any registration", () => {
    expect(registry.list()).toHaveLength(0);
  });

  it("returns all registered adapters", () => {
    registry.register(makeAdapter("crm", "crm_task"));
    registry.register(makeAdapter("support", "support_ticket"));
    expect(registry.list()).toHaveLength(2);
    expect(registry.list().map((a) => a.kindLabel)).toEqual([
      "crm_task",
      "support_ticket",
    ]);
  });

  it("is idempotent: same module+kindLabel registered twice counts once", () => {
    const adapter = makeAdapter("crm", "crm_task");
    registry.register(adapter);
    registry.register(adapter);
    expect(registry.list()).toHaveLength(1);
  });

  it("list is readonly — pushing to the returned array does not grow the registry", () => {
    registry.register(makeAdapter("crm", "crm_task"));
    const list = registry.list() as AttentionSourceAdapter[];
    list.push(makeAdapter("extra", "extra"));
    expect(registry.list()).toHaveLength(1);
  });

  it("preserves supportsAfterCursor on registered adapters", () => {
    registry.register(makeAdapter("crm", "crm_task"));
    registry.register(makeCursorAdapter("support", "support_ticket"));
    const [a, b] = registry.list();
    expect(a?.supportsAfterCursor).toBe(false);
    expect(b?.supportsAfterCursor).toBe(true);
  });
});
```

- [ ] **Step 3.2: Run to confirm it fails**

```
pnpm exec jest --ci --runInBand --testPathPattern="attention-adapter.registry"
```

Expected: FAIL — module not found.

- [ ] **Step 3.3: Implement `attention-adapter.registry.ts`**

Create `src/modules/attention/attention-adapter.registry.ts`:

```ts
import { Injectable } from "@nestjs/common";
import type {
  ModuleTaskInboxItem,
  InboxSourcePosition,
} from "../notifications/dto/unified-inbox.schemas";

export type AttentionSourceAdapter = {
  readonly module: string;
  readonly permission: string;
  readonly kindLabel: string;
  readonly supportsAfterCursor: boolean;
  fetch(
    orgId: string,
    userId: string,
    membershipId: number | null,
    limit: number,
    cursor: InboxSourcePosition | null,
  ): Promise<ModuleTaskInboxItem[]>;
  countPending(
    orgId: string,
    userId: string,
    membershipId: number | null,
  ): Promise<number>;
};

export function attentionAdapterKey(
  adapter: Pick<AttentionSourceAdapter, "module" | "kindLabel">,
): string {
  return `${adapter.module}:${adapter.kindLabel}`;
}

@Injectable()
export class AttentionAdapterRegistry {
  private readonly adapters: AttentionSourceAdapter[] = [];

  register(adapter: AttentionSourceAdapter): void {
    const alreadyRegistered = this.adapters.some(
      (a) => a.module === adapter.module && a.kindLabel === adapter.kindLabel,
    );
    if (!alreadyRegistered) this.adapters.push(adapter);
  }

  list(): readonly AttentionSourceAdapter[] {
    return [...this.adapters];
  }
}
```

- [ ] **Step 3.4: Update `AttentionModule`**

```ts
import { Module } from "@nestjs/common";
import { ApprovalAdapterRegistry } from "./approval-adapter.registry";
import { AttentionAdapterRegistry } from "./attention-adapter.registry";

@Module({
  providers: [ApprovalAdapterRegistry, AttentionAdapterRegistry],
  exports: [ApprovalAdapterRegistry, AttentionAdapterRegistry],
})
export class AttentionModule {}
```

- [ ] **Step 3.5: Run the registry spec**

```
pnpm exec jest --ci --runInBand --testPathPattern="attention-adapter.registry"
```

Expected: all tests pass.

---

## Task 4: CRM activities adapter

**Files:**
- Create: `src/modules/crm/crm-attention-adapter.ts`
- Create: `src/modules/crm/crm-attention-adapter.spec.ts`
- Create: `src/modules/crm/crm-attention.module.ts`
- Modify: `src/modules/crm/crm.module.ts`

**Key facts:**
- Table: `activities` (exported from `../../db/schema`)
- Tenant column: `organizationId` (NOT `orgId`)
- Assignee column: `assigneeUserId` (user ID string, NOT membership ID)
- Filter: `kind = 'task'`, `completedAt IS NULL`, `deletedAt IS NULL`
- Index used: `idx_activities_assignee_open` on `(organizationId, assigneeUserId, dueAt)` partial where `kind = 'task' and completed_at is null and deleted_at is null`
- Cursor: `supportsAfterCursor: false` (primary key is text UUID, not integer)
- Permission: `crm:activities:view` (confirmed in `src/modules/activities/activities.controller.ts`)
- Deep link: `/crm/activities` (confirmed by `app/(authenticated)/crm/activities/page.tsx`)
- `taskKind: "crm_task"`, `sourceModule: "crm"`, `dedupKey: "task:crm:<activityId>"`
- `timestamp` field uses `createdAt` (activities don't have a reliable sort timestamp other than creation for inbox purposes; `dueAt` is nullable and could be far in the future)
- `body` uses `activities.subject` (what the task is about) or empty string if null
- `priority` is hardcoded to `"normal"` (the activities schema has no priority column)
- `status` is hardcoded to `"open"` (we only fetch open tasks)

**Interfaces:**
- Produces: `CrmAttentionAdapter` (injectable, registers on `OnModuleInit`)
- Produces: `CrmAttentionModule` (imports `AttentionModule`)

- [ ] **Step 4.1: Write the failing spec**

Create `src/modules/crm/crm-attention-adapter.spec.ts`:

```ts
import { activities } from "../../db/schema";
import { AttentionAdapterRegistry } from "../attention/attention-adapter.registry";
import { CrmAttentionAdapter } from "./crm-attention-adapter";
import { makeFakeDb } from "../../test/fake-select-db";

const ORG = "org-1";
const OTHER_ORG = "org-2";
const USER = "user-uuid-1";
const OTHER_USER = "user-uuid-2";

function seedActivity(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    activity_id: "act-uuid-1",
    organization_id: ORG,
    kind: "task",
    occurred_at: new Date("2026-09-20T10:00:00.000Z"),
    subject: "Follow up with customer",
    body: null,
    due_at: new Date("2026-09-24T00:00:00.000Z"),
    completed_at: null,
    assignee_user_id: USER,
    actor_kind: "human",
    actor_user_id: USER,
    deleted_at: null,
    created_at: new Date("2026-09-20T10:00:00.000Z"),
    updated_at: new Date("2026-09-20T10:00:00.000Z"),
    source: "manual",
    ...overrides,
  };
}

function makeAdapter(): { adapter: CrmAttentionAdapter; registry: AttentionAdapterRegistry } {
  const registry = new AttentionAdapterRegistry();
  const adapter = new CrmAttentionAdapter(makeFakeDb({}) as never, registry);
  return { adapter, registry };
}

describe("CrmAttentionAdapter", () => {
  it("registers itself in the attention registry on init", () => {
    const { adapter, registry } = makeAdapter();
    adapter.onModuleInit();
    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0]?.kindLabel).toBe("crm_task");
  });

  it("returns open tasks assigned to the caller", async () => {
    const db = makeFakeDb({
      activities: [seedActivity()],
    });
    const { adapter, registry } = makeAdapter();
    adapter["db"] = db as never;
    adapter.onModuleInit();

    const registered = registry.list()[0];
    const items = await registered?.fetch(ORG, USER, null, 10, null);

    expect(items).toHaveLength(1);
    expect(items?.[0]?.kind).toBe("module_task");
    expect(items?.[0]?.taskKind).toBe("crm_task");
    expect(items?.[0]?.dedupKey).toBe("task:crm:act-uuid-1");
    expect(items?.[0]?.deepLink).toBe("/crm/activities");
  });

  it("CONTROL: returns empty when no tasks are assigned to the caller", async () => {
    const db = makeFakeDb({
      activities: [seedActivity({ assignee_user_id: OTHER_USER })],
    });
    const { adapter, registry } = makeAdapter();
    adapter["db"] = db as never;
    adapter.onModuleInit();

    const registered = registry.list()[0];
    const items = await registered?.fetch(ORG, USER, null, 10, null);

    expect(items).toHaveLength(0);
  });

  it("excludes completed tasks", async () => {
    const db = makeFakeDb({
      activities: [seedActivity({ completed_at: new Date("2026-09-20T11:00:00.000Z") })],
    });
    const { adapter, registry } = makeAdapter();
    adapter["db"] = db as never;
    adapter.onModuleInit();

    const items = await registry.list()[0]?.fetch(ORG, USER, null, 10, null);
    expect(items).toHaveLength(0);
  });

  it("excludes soft-deleted tasks", async () => {
    const db = makeFakeDb({
      activities: [seedActivity({ deleted_at: new Date("2026-09-21T00:00:00.000Z") })],
    });
    const { adapter, registry } = makeAdapter();
    adapter["db"] = db as never;
    adapter.onModuleInit();

    const items = await registry.list()[0]?.fetch(ORG, USER, null, 10, null);
    expect(items).toHaveLength(0);
  });

  it("does not cross tenant boundaries", async () => {
    const db = makeFakeDb({
      activities: [
        seedActivity({ organization_id: OTHER_ORG, assignee_user_id: USER }),
        seedActivity({ activity_id: "act-uuid-2" }),
      ],
    });
    const { adapter, registry } = makeAdapter();
    adapter["db"] = db as never;
    adapter.onModuleInit();

    const items = await registry.list()[0]?.fetch(ORG, USER, null, 10, null);
    expect(items).toHaveLength(1);
    expect(items?.[0]?.dedupKey).toBe("task:crm:act-uuid-2");
  });

  it("countPending returns the number of open tasks assigned to the caller", async () => {
    const db = makeFakeDb({
      activities: [
        seedActivity({ activity_id: "act-1" }),
        seedActivity({ activity_id: "act-2" }),
        seedActivity({ activity_id: "act-3", completed_at: new Date() }),
      ],
    });
    const { adapter, registry } = makeAdapter();
    adapter["db"] = db as never;
    adapter.onModuleInit();

    const count = await registry.list()[0]?.countPending(ORG, USER, null);
    expect(count).toBe(2);
  });

  it("CONTROL: countPending returns 0 for a different org", async () => {
    const db = makeFakeDb({
      activities: [seedActivity({ organization_id: OTHER_ORG })],
    });
    const { adapter, registry } = makeAdapter();
    adapter["db"] = db as never;
    adapter.onModuleInit();

    const count = await registry.list()[0]?.countPending(ORG, USER, null);
    expect(count).toBe(0);
  });

  it("supportsAfterCursor is false — UUID pk cannot be used as a numeric keyset", () => {
    const { adapter, registry } = makeAdapter();
    adapter.onModuleInit();
    expect(registry.list()[0]?.supportsAfterCursor).toBe(false);
  });
});
```

- [ ] **Step 4.2: Run to confirm failure**

```
pnpm exec jest --ci --runInBand --testPathPattern="crm-attention-adapter"
```

Expected: FAIL — module not found.

- [ ] **Step 4.3: Implement `crm-attention-adapter.ts`**

Create `src/modules/crm/crm-attention-adapter.ts`:

```ts
import { Inject, Injectable, OnModuleInit } from "@nestjs/common";
import { and, count, eq, isNull } from "drizzle-orm";
import { activities } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import {
  AttentionAdapterRegistry,
} from "../attention/attention-adapter.registry";
import type {
  ModuleTaskInboxItem,
  InboxSourcePosition,
} from "../notifications/dto/unified-inbox.schemas";

@Injectable()
export class CrmAttentionAdapter implements OnModuleInit {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly registry: AttentionAdapterRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      module: "crm",
      kindLabel: "crm_task",
      permission: "crm:activities:view",
      supportsAfterCursor: false,
      fetch: (orgId, userId, _membershipId, limit, _cursor) =>
        this.fetchTasks(orgId, userId, limit),
      countPending: (orgId, userId) =>
        this.countPendingTasks(orgId, userId),
    });
  }

  private async fetchTasks(
    orgId: string,
    userId: string,
    limit: number,
  ): Promise<ModuleTaskInboxItem[]> {
    const rows = await this.db
      .select({
        activityId: activities.activityId,
        subject: activities.subject,
        dueAt: activities.dueAt,
        createdAt: activities.createdAt,
        actorUserId: activities.actorUserId,
      })
      .from(activities)
      .where(
        and(
          eq(activities.organizationId, orgId),
          eq(activities.assigneeUserId, userId),
          eq(activities.kind, "task"),
          isNull(activities.completedAt),
          isNull(activities.deletedAt),
        ),
      )
      .orderBy(activities.createdAt)
      .limit(limit);

    return rows.map(
      (row): ModuleTaskInboxItem => ({
        kind: "module_task",
        id: row.activityId,
        taskKind: "crm_task",
        status: "open",
        priority: "normal",
        dueAt: row.dueAt ? row.dueAt.toISOString() : null,
        body: row.subject ?? "",
        sourceModule: "crm",
        subject: row.subject ?? "CRM task",
        actor: null,
        timestamp: row.createdAt.toISOString(),
        isRead: false,
        deepLink: "/crm/activities",
        dedupKey: `task:crm:${row.activityId}`,
      }),
    );
  }

  private async countPendingTasks(
    orgId: string,
    userId: string,
  ): Promise<number> {
    const rows = await this.db
      .select({ cnt: count() })
      .from(activities)
      .where(
        and(
          eq(activities.organizationId, orgId),
          eq(activities.assigneeUserId, userId),
          eq(activities.kind, "task"),
          isNull(activities.completedAt),
          isNull(activities.deletedAt),
        ),
      );
    return Number(rows[0]?.cnt ?? 0);
  }
}
```

- [ ] **Step 4.4: Create `crm-attention.module.ts`**

```ts
import { Module } from "@nestjs/common";
import { AttentionModule } from "../attention/attention.module";
import { CrmAttentionAdapter } from "./crm-attention-adapter";

@Module({
  imports: [AttentionModule],
  providers: [CrmAttentionAdapter],
})
export class CrmAttentionModule {}
```

- [ ] **Step 4.5: Import `CrmAttentionModule` in `crm.module.ts`**

```ts
import { CrmAttentionModule } from "./crm-attention.module";

const CRM_MODULES = [
  CrmModule,
  CrmAutomationStudioModule,
  CrmCustomFieldsModule,
  CrmInboxModule,
  CrmMetadataModule,
  CrmPricebooksModule,
  CrmAttentionModule,
];
```

- [ ] **Step 4.6: Run the CRM adapter spec**

```
pnpm exec jest --ci --runInBand --testPathPattern="crm-attention-adapter"
```

Expected: all tests pass.

---

## Task 5: Support tickets adapter

**Files:**
- Create: `src/modules/support/support-attention-adapter.ts`
- Create: `src/modules/support/support-attention-adapter.spec.ts`
- Create: `src/modules/support/support-attention.module.ts`
- Modify: `src/modules/support/support.module.ts`

**Key facts:**
- Table: `supportTickets` (exported from `../../db/schema`)
- Tenant column: `orgId`
- Assignee column: `assigneeMembershipId` (integer membership ID)
- Open/unresolved statuses: `"OPEN"`, `"IN_PROGRESS"`, `"WAITING"` (from `supportTicketStatusEnum`: `["OPEN", "IN_PROGRESS", "WAITING", "RESOLVED", "CLOSED"]`)
- Index used: `idx_support_tickets_org_assignee_actor` on `(orgId, assigneeMembershipId, createdAt)`
- Cursor: `supportsAfterCursor: true` (serial integer PK)
- Keyset: `descKeyset(supportTickets.createdAt, supportTickets.id, cursor)` — newest first
- Permission: `support:tickets:view` (confirmed in `src/modules/support/core/support-tickets.controller.ts`)
- Deep link: `/support/inbox` (confirmed by `app/(authenticated)/support/inbox/page.tsx`)
- `taskKind: "support_ticket"`, `sourceModule: "support"`, `dedupKey: "task:support:<id>"`
- `body` uses `supportTickets.description` (nullable, empty string fallback)
- `priority` maps the ticket priority enum value directly (LOW, MEDIUM, HIGH, URGENT)
- `status` maps the ticket status enum value directly
- `membershipId` is required — return empty if null

**Interfaces:**
- Produces: `SupportAttentionAdapter` (injectable, registers on `OnModuleInit`)
- Consumes: `descKeyset` from `../../common/pagination/desc-keyset`
- Produces: `SupportAttentionModule`

- [ ] **Step 5.1: Write the failing spec**

Create `src/modules/support/support-attention-adapter.spec.ts`:

```ts
import { supportTickets } from "../../db/schema";
import { AttentionAdapterRegistry } from "../attention/attention-adapter.registry";
import { SupportAttentionAdapter } from "./support-attention-adapter";
import { makeFakeDb } from "../../test/fake-select-db";

const ORG = "org-1";
const OTHER_ORG = "org-2";
const MEMBERSHIP = 10;
const OTHER_MEMBERSHIP = 20;
const USER = "user-uuid-1";

function seedTicket(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 1,
    org_id: ORG,
    assignee_membership_id: MEMBERSHIP,
    title: "Login page broken",
    description: "Cannot log in via email",
    status: "OPEN",
    priority: "HIGH",
    created_by_membership_id: 5,
    source_channel: "web",
    sla_paused_minutes: 0,
    sla_escalation_level: 0,
    created_at: new Date("2026-09-20T10:00:00.000Z"),
    updated_at: new Date("2026-09-20T10:00:00.000Z"),
    ...overrides,
  };
}

function makeAdapter(): {
  adapter: SupportAttentionAdapter;
  registry: AttentionAdapterRegistry;
} {
  const registry = new AttentionAdapterRegistry();
  const adapter = new SupportAttentionAdapter(
    makeFakeDb({}) as never,
    registry,
  );
  return { adapter, registry };
}

describe("SupportAttentionAdapter", () => {
  it("registers itself in the attention registry on init", () => {
    const { adapter, registry } = makeAdapter();
    adapter.onModuleInit();
    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0]?.kindLabel).toBe("support_ticket");
  });

  it("returns open tickets assigned to the caller's membership", async () => {
    const db = makeFakeDb({ support_tickets: [seedTicket()] });
    const { adapter, registry } = makeAdapter();
    adapter["db"] = db as never;
    adapter.onModuleInit();

    const items = await registry.list()[0]?.fetch(ORG, USER, MEMBERSHIP, 10, null);
    expect(items).toHaveLength(1);
    expect(items?.[0]?.kind).toBe("module_task");
    expect(items?.[0]?.taskKind).toBe("support_ticket");
    expect(items?.[0]?.dedupKey).toBe("task:support:1");
    expect(items?.[0]?.deepLink).toBe("/support/inbox");
    expect(items?.[0]?.priority).toBe("HIGH");
    expect(items?.[0]?.status).toBe("OPEN");
  });

  it("CONTROL: returns empty for a different membership", async () => {
    const db = makeFakeDb({
      support_tickets: [seedTicket({ assignee_membership_id: OTHER_MEMBERSHIP })],
    });
    const { adapter, registry } = makeAdapter();
    adapter["db"] = db as never;
    adapter.onModuleInit();

    const items = await registry.list()[0]?.fetch(ORG, USER, MEMBERSHIP, 10, null);
    expect(items).toHaveLength(0);
  });

  it("returns empty when membershipId is null", async () => {
    const db = makeFakeDb({ support_tickets: [seedTicket()] });
    const { adapter, registry } = makeAdapter();
    adapter["db"] = db as never;
    adapter.onModuleInit();

    const items = await registry.list()[0]?.fetch(ORG, USER, null, 10, null);
    expect(items).toHaveLength(0);
  });

  it("excludes resolved tickets", async () => {
    const db = makeFakeDb({
      support_tickets: [seedTicket({ status: "RESOLVED" })],
    });
    const { adapter, registry } = makeAdapter();
    adapter["db"] = db as never;
    adapter.onModuleInit();

    const items = await registry.list()[0]?.fetch(ORG, USER, MEMBERSHIP, 10, null);
    expect(items).toHaveLength(0);
  });

  it("excludes closed tickets", async () => {
    const db = makeFakeDb({
      support_tickets: [seedTicket({ status: "CLOSED" })],
    });
    const { adapter, registry } = makeAdapter();
    adapter["db"] = db as never;
    adapter.onModuleInit();

    const items = await registry.list()[0]?.fetch(ORG, USER, MEMBERSHIP, 10, null);
    expect(items).toHaveLength(0);
  });

  it("includes IN_PROGRESS and WAITING tickets", async () => {
    const db = makeFakeDb({
      support_tickets: [
        seedTicket({ id: 2, status: "IN_PROGRESS" }),
        seedTicket({ id: 3, status: "WAITING" }),
      ],
    });
    const { adapter, registry } = makeAdapter();
    adapter["db"] = db as never;
    adapter.onModuleInit();

    const items = await registry.list()[0]?.fetch(ORG, USER, MEMBERSHIP, 10, null);
    expect(items).toHaveLength(2);
  });

  it("does not cross tenant boundaries", async () => {
    const db = makeFakeDb({
      support_tickets: [
        seedTicket({ id: 1, org_id: OTHER_ORG, assignee_membership_id: MEMBERSHIP }),
        seedTicket({ id: 2 }),
      ],
    });
    const { adapter, registry } = makeAdapter();
    adapter["db"] = db as never;
    adapter.onModuleInit();

    const items = await registry.list()[0]?.fetch(ORG, USER, MEMBERSHIP, 10, null);
    expect(items).toHaveLength(1);
    expect(items?.[0]?.dedupKey).toBe("task:support:2");
  });

  it("countPending returns count of open tickets", async () => {
    const db = makeFakeDb({
      support_tickets: [
        seedTicket({ id: 1, status: "OPEN" }),
        seedTicket({ id: 2, status: "IN_PROGRESS" }),
        seedTicket({ id: 3, status: "RESOLVED" }),
      ],
    });
    const { adapter, registry } = makeAdapter();
    adapter["db"] = db as never;
    adapter.onModuleInit();

    const count = await registry.list()[0]?.countPending(ORG, USER, MEMBERSHIP);
    expect(count).toBe(2);
  });

  it("CONTROL: countPending returns 0 for a different org", async () => {
    const db = makeFakeDb({
      support_tickets: [
        seedTicket({ org_id: OTHER_ORG, assignee_membership_id: MEMBERSHIP }),
      ],
    });
    const { adapter, registry } = makeAdapter();
    adapter["db"] = db as never;
    adapter.onModuleInit();

    const count = await registry.list()[0]?.countPending(ORG, USER, MEMBERSHIP);
    expect(count).toBe(0);
  });

  it("supportsAfterCursor is true — serial integer pk enables numeric keyset", () => {
    const { adapter, registry } = makeAdapter();
    adapter.onModuleInit();
    expect(registry.list()[0]?.supportsAfterCursor).toBe(true);
  });
});
```

- [ ] **Step 5.2: Run to confirm failure**

```
pnpm exec jest --ci --runInBand --testPathPattern="support-attention-adapter"
```

Expected: FAIL — module not found.

- [ ] **Step 5.3: Implement `support-attention-adapter.ts`**

Create `src/modules/support/support-attention-adapter.ts`:

```ts
import { Inject, Injectable, OnModuleInit } from "@nestjs/common";
import { and, count, eq, inArray } from "drizzle-orm";
import { supportTickets } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { descKeyset } from "../../common/pagination/desc-keyset";
import {
  AttentionAdapterRegistry,
} from "../attention/attention-adapter.registry";
import type {
  ModuleTaskInboxItem,
  InboxSourcePosition,
} from "../notifications/dto/unified-inbox.schemas";

const OPEN_STATUSES = ["OPEN", "IN_PROGRESS", "WAITING"] as const;

@Injectable()
export class SupportAttentionAdapter implements OnModuleInit {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly registry: AttentionAdapterRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      module: "support",
      kindLabel: "support_ticket",
      permission: "support:tickets:view",
      supportsAfterCursor: true,
      fetch: (orgId, userId, membershipId, limit, cursor) =>
        this.fetchTickets(orgId, membershipId, limit, cursor),
      countPending: (orgId, _userId, membershipId) =>
        this.countPendingTickets(orgId, membershipId),
    });
  }

  private async fetchTickets(
    orgId: string,
    membershipId: number | null,
    limit: number,
    cursor: InboxSourcePosition | null,
  ): Promise<ModuleTaskInboxItem[]> {
    if (membershipId === null) return [];

    const rows = await this.db
      .select({
        id: supportTickets.id,
        title: supportTickets.title,
        description: supportTickets.description,
        status: supportTickets.status,
        priority: supportTickets.priority,
        slaDeadline: supportTickets.slaDeadline,
        createdAt: supportTickets.createdAt,
      })
      .from(supportTickets)
      .where(
        and(
          eq(supportTickets.orgId, orgId),
          eq(supportTickets.assigneeMembershipId, membershipId),
          inArray(supportTickets.status, [...OPEN_STATUSES]),
          descKeyset(supportTickets.createdAt, supportTickets.id, cursor),
        ),
      )
      .orderBy(supportTickets.createdAt, supportTickets.id)
      .limit(limit);

    return rows.map(
      (row): ModuleTaskInboxItem => ({
        kind: "module_task",
        id: String(row.id),
        taskKind: "support_ticket",
        status: row.status,
        priority: row.priority,
        dueAt: row.slaDeadline ? row.slaDeadline.toISOString() : null,
        body: row.description ?? "",
        sourceModule: "support",
        subject: row.title,
        actor: null,
        timestamp: row.createdAt.toISOString(),
        isRead: false,
        deepLink: "/support/inbox",
        dedupKey: `task:support:${String(row.id)}`,
      }),
    );
  }

  private async countPendingTickets(
    orgId: string,
    membershipId: number | null,
  ): Promise<number> {
    if (membershipId === null) return 0;
    const rows = await this.db
      .select({ cnt: count() })
      .from(supportTickets)
      .where(
        and(
          eq(supportTickets.orgId, orgId),
          eq(supportTickets.assigneeMembershipId, membershipId),
          inArray(supportTickets.status, [...OPEN_STATUSES]),
        ),
      );
    return Number(rows[0]?.cnt ?? 0);
  }
}
```

- [ ] **Step 5.4: Create `support-attention.module.ts`**

```ts
import { Module } from "@nestjs/common";
import { AttentionModule } from "../attention/attention.module";
import { SupportAttentionAdapter } from "./support-attention-adapter";

@Module({
  imports: [AttentionModule],
  providers: [SupportAttentionAdapter],
})
export class SupportAttentionModule {}
```

- [ ] **Step 5.5: Import `SupportAttentionModule` in `support.module.ts`**

```ts
import { SupportAttentionModule } from "./support-attention.module";

const SUPPORT_MODULES = [SupportModule, SupportKbGapModule, SupportAttentionModule];
```

- [ ] **Step 5.6: Run the support adapter spec**

```
pnpm exec jest --ci --runInBand --testPathPattern="support-attention-adapter"
```

Expected: all tests pass.

---

## Task 6: Wire `AttentionAdapterRegistry` into `UnifiedInboxService`

**Files:**
- Modify: `src/modules/notifications/unified-inbox.service.ts`

**Interfaces:**
- Consumes: `AttentionAdapterRegistry`, `attentionAdapterKey` from `attention-adapter.registry`
- Consumes: `ModuleTaskInboxItem` from `unified-inbox.schemas`

- [ ] **Step 6.1: Write the failing test for the task source path**

Add a new spec file `src/modules/notifications/unified-inbox-task-contract.spec.ts`:

```ts
jest.mock("@composio/core", () => ({ Composio: jest.fn() }));

import type { Db } from "../../db/drizzle.module";
import { ApprovalAdapterRegistry } from "../attention/approval-adapter.registry";
import { AttentionAdapterRegistry } from "../attention/attention-adapter.registry";
import type { AttentionSourceAdapter } from "../attention/attention-adapter.registry";
import type { BuildApprovalsInboxService } from "../build/approvals/build-approvals-inbox.service";
import type { AccessService } from "../access/access.service";
import { UnifiedInboxService } from "./unified-inbox.service";
import { makeBroadcasts, makeUser, ORG, UID, MEMBERSHIP } from "./approval-cursor.spec-fixtures";
import type { MailService } from "../mail/mail.service";
import type { ModuleTaskInboxItem } from "./dto/unified-inbox.schemas";

function makeMail(): MailService {
  return {
    listMessages: jest.fn().mockResolvedValue({ messages: [], nextCursor: null, accountErrors: [] }),
    countUnread: jest.fn().mockResolvedValue({ unread: 0, exact: true }),
    areAllAccountsFresh: jest.fn().mockResolvedValue(true),
  } as unknown as MailService;
}

function taskItem(id: string, taskKind: string): ModuleTaskInboxItem {
  return {
    kind: "module_task",
    id,
    taskKind,
    status: "open",
    priority: "normal",
    dueAt: null,
    body: "do the thing",
    sourceModule: "crm",
    actor: null,
    subject: "Task subject",
    timestamp: new Date("2026-09-20T00:00:00.000Z").toISOString(),
    isRead: false,
    deepLink: "/crm/activities",
    dedupKey: `task:crm:${id}`,
  };
}

function stubAttentionAdapter(
  overrides: Partial<AttentionSourceAdapter> &
    Pick<AttentionSourceAdapter, "module" | "kindLabel">,
): AttentionSourceAdapter {
  return {
    permission: `${overrides.module}:test:view`,
    supportsAfterCursor: false,
    fetch: () => Promise.resolve([]),
    countPending: () => Promise.resolve(0),
    ...overrides,
  };
}

function makeService(
  attentionRegistry: AttentionAdapterRegistry,
  access: AccessService,
): UnifiedInboxService {
  const db = {
    select: () => ({
      from: () => ({
        leftJoin: () => ({ where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([]) }) }) }),
        where: () => Promise.resolve([{ cnt: 0 }]),
        innerJoin: () => ({ where: () => Promise.resolve([{ cnt: 0 }]) }),
      }),
    }),
  } as unknown as Db;
  return new UnifiedInboxService(
    db,
    access,
    makeMail(),
    makeBroadcasts(),
    { getInboxPage: jest.fn().mockResolvedValue([]), countPending: jest.fn().mockResolvedValue(0) } as unknown as BuildApprovalsInboxService,
    new ApprovalAdapterRegistry(),
    attentionRegistry,
  );
}

function makeAccessHolding(granted: ReadonlySet<string>): AccessService {
  return {
    holds: jest.fn((_user: unknown, key: string) => Promise.resolve(granted.has(key))),
    membersWithPermission: jest.fn().mockResolvedValue([]),
  } as unknown as AccessService;
}

describe("module_task items reach the inbox page", () => {
  it("delivers tasks from registered attention adapters", async () => {
    const registry = new AttentionAdapterRegistry();
    registry.register(
      stubAttentionAdapter({
        module: "crm",
        kindLabel: "crm_task",
        permission: "crm:activities:view",
        fetch: () => Promise.resolve([taskItem("uuid-1", "crm_task")]),
      }),
    );

    const svc = makeService(registry, makeAccessHolding(new Set(["crm:activities:view"])));
    const page = await svc.list(ORG, UID, { limit: 25, kinds: ["module_task"], unreadOnly: false }, makeUser());

    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.kind).toBe("module_task");
    expect(page.items[0]?.dedupKey).toBe("task:crm:uuid-1");
  });

  it("CONTROL: tasks are excluded when no kinds filter includes module_task", async () => {
    const registry = new AttentionAdapterRegistry();
    registry.register(
      stubAttentionAdapter({
        module: "crm",
        kindLabel: "crm_task",
        permission: "crm:activities:view",
        fetch: () => Promise.resolve([taskItem("uuid-1", "crm_task")]),
      }),
    );

    const svc = makeService(registry, makeAccessHolding(new Set(["crm:activities:view"])));
    const page = await svc.list(ORG, UID, { limit: 25, kinds: ["notification", "mail", "build_approval"], unreadOnly: false }, makeUser());

    expect(page.items.filter((i) => i.kind === "module_task")).toHaveLength(0);
  });

  it("skips module_task source when triage is not active", async () => {
    const registry = new AttentionAdapterRegistry();
    registry.register(
      stubAttentionAdapter({
        module: "crm",
        kindLabel: "crm_task",
        permission: "crm:activities:view",
        fetch: () => Promise.resolve([taskItem("uuid-1", "crm_task")]),
      }),
    );

    const svc = makeService(registry, makeAccessHolding(new Set(["crm:activities:view"])));
    const page = await svc.list(ORG, UID, { limit: 25, unreadOnly: false, triage: "done" }, makeUser());

    const taskSource = page.sources.find((s) => s.kind === "module_task");
    expect(taskSource?.included).toBe(false);
    expect(taskSource?.reason).toContain("unsupported: triage");
  });

  it("task count is included in unifiedUnreadCount", async () => {
    const registry = new AttentionAdapterRegistry();
    registry.register(
      stubAttentionAdapter({
        module: "crm",
        kindLabel: "crm_task",
        permission: "crm:activities:view",
        countPending: () => Promise.resolve(3),
      }),
    );

    const svc = makeService(registry, makeAccessHolding(new Set(["crm:activities:view"])));
    const counts = await svc.unifiedUnreadCount(ORG, UID, makeUser());

    expect(counts.task).toBe(3);
    expect(counts.total).toBe(counts.notification + counts.mail + counts.approval + counts.task);
  });

  it("CONTROL: task count is 0 when no permission", async () => {
    const registry = new AttentionAdapterRegistry();
    registry.register(
      stubAttentionAdapter({
        module: "crm",
        kindLabel: "crm_task",
        permission: "crm:activities:view",
        countPending: () => Promise.resolve(5),
      }),
    );

    const svc = makeService(registry, makeAccessHolding(new Set()));
    const counts = await svc.unifiedUnreadCount(ORG, UID, makeUser());

    expect(counts.task).toBe(0);
  });
});
```

- [ ] **Step 6.2: Update ALL existing test files that call `new UnifiedInboxService(...)`**

Each call site must add `new AttentionAdapterRegistry()` as the 7th argument. The affected files are:

- `src/modules/notifications/approval-cursor.spec-fixtures.ts` — update `makeInbox` function
- `src/modules/notifications/unified-inbox.spec.ts` — multiple `new UnifiedInboxService(...)` calls
- `src/modules/notifications/unified-inbox-contract.spec.ts` — multiple calls
- `src/modules/notifications/unified-inbox-attention-contract.spec.ts` — `makeService` function
- `src/modules/notifications/unified-inbox-approval-ordering.spec.ts` — 2 calls
- `src/modules/notifications/unified-inbox-partial-availability.spec.ts` — multiple calls
- `src/modules/notifications/unified-inbox-ordering.spec.ts` — 4 calls
- `src/modules/notifications/unified-inbox-mail-unread.spec.ts` — multiple calls
- `src/modules/notifications/unified-inbox-mail-cursor.spec.ts` — 1 call
- `src/modules/notifications/unified-inbox-filters.spec.ts` — multiple calls
- `src/modules/notifications/unified-inbox-snooze.spec.ts` — 1 call
- `src/modules/notifications/unified-inbox-tenant-isolation.spec.ts` — 3 calls

For each file:
1. Add `import { AttentionAdapterRegistry } from "../attention/attention-adapter.registry";` at the top
2. For each `new UnifiedInboxService(db, ..., registry)` call, append `, new AttentionAdapterRegistry()` as the last argument

Example transformation for `approval-cursor.spec-fixtures.ts`:
```ts
// BEFORE:
export function makeInbox(db: Db, registry: ApprovalAdapterRegistry): UnifiedInboxService {
  return new UnifiedInboxService(db, makeAccess(), makeMail(), makeBroadcasts(), makeBuildApprovals(), registry);
}

// AFTER:
import { AttentionAdapterRegistry } from "../attention/attention-adapter.registry";
export function makeInbox(db: Db, registry: ApprovalAdapterRegistry): UnifiedInboxService {
  return new UnifiedInboxService(db, makeAccess(), makeMail(), makeBroadcasts(), makeBuildApprovals(), registry, new AttentionAdapterRegistry());
}
```

- [ ] **Step 6.3: Implement the service changes in `unified-inbox.service.ts`**

The full set of changes:

**a. New imports:**
```ts
import {
  AttentionAdapterRegistry,
  attentionAdapterKey,
  type AttentionSourceAdapter,
} from "../attention/attention-adapter.registry";
import type { ModuleTaskInboxItem } from "./dto/unified-inbox.schemas";
```

**b. Add `ModuleTaskInboxItem` to the import from schemas:**
```ts
type ModuleTaskInboxItem,
```

**c. Extend constructor:**
```ts
constructor(
  @Inject(DRIZZLE) private readonly db: Db,
  private readonly access: AccessService,
  private readonly mail: MailService,
  private readonly broadcasts: BroadcastsService,
  private readonly buildApprovals: BuildApprovalsInboxService,
  private readonly registry: ApprovalAdapterRegistry,
  private readonly attentionRegistry: AttentionAdapterRegistry,
) {}
```

**d. New `AttentionFetchResult` type and `fetchAllAttentionAdapters` method** (modeled after `fetchAllAdapters`):
```ts
type AttentionFetchResult = {
  items: ModuleTaskInboxItem[];
  errors: string[];
  permDenied: string[];
  unsupportedOnPage2: string[];
  allAdapters: readonly AttentionSourceAdapter[];
  adapterByDedupKey: Map<string, string>;
};

private async fetchAllAttentionAdapters(
  orgId: string,
  userId: string,
  membershipId: number | null,
  user: CurrentUserContext,
  limit: number,
  resuming: boolean,
  positionOf: (adapter: AttentionSourceAdapter) => InboxSourcePosition | null,
): Promise<AttentionFetchResult> {
  const allAdapters = this.attentionRegistry.list();
  const items: ModuleTaskInboxItem[] = [];
  const errors: string[] = [];
  const permDenied: string[] = [];
  const unsupportedOnPage2: string[] = [];
  const adapterByDedupKey = new Map<string, string>();
  await Promise.all(
    allAdapters.map(async (adapter) => {
      if (resuming && !adapter.supportsAfterCursor) {
        unsupportedOnPage2.push(adapter.kindLabel);
        return;
      }
      const canView = await this.access.holds(user, adapter.permission);
      if (!canView) {
        permDenied.push(adapter.permission);
        return;
      }
      const outcome = await readSource(() =>
        adapter.fetch(orgId, userId, membershipId, limit, positionOf(adapter)),
      );
      if (!outcome.ok) {
        errors.push(outcome.error);
        return;
      }
      const key = attentionAdapterKey(adapter);
      for (const item of outcome.value)
        adapterByDedupKey.set(item.dedupKey, key);
      items.push(...outcome.value);
    }),
  );
  return { items, errors, permDenied, unsupportedOnPage2, allAdapters, adapterByDedupKey };
}
```

**e. New `moduleTaskSourceStatus` function** (top-level, beside `buildApprovalSourceStatus`):
```ts
function moduleTaskSourceStatus(
  wants: boolean,
  tasksSupport: boolean,
  result: AttentionFetchResult | null,
  searching: boolean,
): SourceStatus {
  if (!wants) return skippedSource("module_task", null);
  if (!tasksSupport)
    return skippedSource(
      "module_task",
      "unsupported: triage (tasks have no archive state)",
    );
  if (result === null) return skippedSource("module_task", null);
  const { allAdapters, permDenied, errors, unsupportedOnPage2 } = result;
  if (allAdapters.length > 0 && permDenied.length === allAdapters.length)
    return skippedSource("module_task", `no permission: ${permDenied.join(", ")}`);
  const errParts: string[] = [];
  if (errors.length > 0) errParts.push(errors.join("; "));
  if (unsupportedOnPage2.length > 0)
    errParts.push(
      `unsupported: ${unsupportedOnPage2.join(", ")} adapters have no cursor`,
    );
  if (searching)
    errParts.push(
      "unsupported: tasks are searched within the fetched page, not the whole queue",
    );
  return {
    kind: "module_task",
    included: true,
    reason: null,
    available: errors.length === 0,
    error: errParts.length > 0 ? errParts.join("; ") : null,
  };
}
```

**f. Update `list` method:**

Add `wantsModuleTasks`, `tasksSupport`, `taskPositionOf` variables, add to the `Promise.all`, add to sources array, add `taskItems` to `merged`, add `mt` to cursor:

```ts
// In list():
const wantsModuleTasks = kindsFilter.includes("module_task");
const tasksSupport = triage === "active";

// Add to kindsFilter default:
const kindsFilter: InboxKind[] =
  query.kinds && query.kinds.length > 0
    ? query.kinds
    : ["notification", "broadcast", "mail", "build_approval", "module_task"];

// In the positionOf section:
const taskPositionOf = (
  adapter: AttentionSourceAdapter,
): InboxSourcePosition | null =>
  cursorState.mt[attentionAdapterKey(adapter)] ?? null;

// Add to Promise.all (after the approvals entry):
wantsModuleTasks && tasksSupport
  ? this.fetchAllAttentionAdapters(
      orgId, userId, membershipId, user, limit + 1, resuming, taskPositionOf,
    )
  : null,

// Update destructuring:
const [notifOutcome, broadcastOutcome, mailOutcome, adapterResult, taskResult] = await Promise.all([...]);

// Add taskItems:
const taskItems = applyQFilter(taskResult?.items ?? [], filters.q);

// Add to merged:
const merged = stableSortItems([
  ...notifItems, ...broadcastItems, ...mailBatch.items, ...approvalItems, ...taskItems,
]);

// Add to sources:
moduleTaskSourceStatus(
  wantsModuleTasks,
  tasksSupport,
  taskResult ?? null,
  filters.q !== undefined && filters.q.trim() !== "",
),

// Add mt to nextState:
mt: lastDeliveredAdapterPositions(
  page,
  cursorState.mt,
  taskResult?.adapterByDedupKey ?? new Map<string, string>(),
  "module_task",
),
```

**g. Update `inboxItemKind` to handle `module_task`:**
```ts
case "module_task":
  return "module_task";
```

**h. Update `unifiedUnreadCount`:**
```ts
const [notifCount, mailCount, approvalCount, taskCount] = await Promise.all([
  this.countNotificationUnread(orgId, actingMembershipId(user.principal)),
  canMail
    ? this.countMailUnread(orgId, userId, actingMembershipId(user.principal))
    : Promise.resolve({ unread: 0, exact: true }),
  this.countPendingAcrossAdapters(orgId, userId, user),
  this.countPendingAcrossAttentionAdapters(orgId, userId, user),
]);

return {
  notification: notifCount,
  mail: mailCount.unread,
  approval: approvalCount,
  task: taskCount,
  total: notifCount + mailCount.unread + approvalCount + taskCount,
  mailExact: mailCount.exact,
};
```

**i. New `countPendingAcrossAttentionAdapters` method:**
```ts
private async countPendingAcrossAttentionAdapters(
  orgId: string,
  userId: string,
  user: CurrentUserContext,
): Promise<number> {
  const membershipId = actingMembershipId(user.principal);
  if (membershipId === null) return 0;
  const counts = await Promise.all(
    this.attentionRegistry.list().map(async (adapter) => {
      if (!(await this.access.holds(user, adapter.permission))) return 0;
      const outcome = await readSource(() =>
        adapter.countPending(orgId, userId, membershipId),
      );
      return outcome.ok ? outcome.value : 0;
    }),
  );
  return counts.reduce((total, n) => total + n, 0);
}
```

- [ ] **Step 6.4: Run typecheck to catch all issues before running tests**

```
node --max-old-space-size=10240 ./node_modules/typescript/bin/tsc --noEmit -p tsconfig.build.json
node --max-old-space-size=10240 ./node_modules/typescript/bin/tsc --noEmit -p tsconfig.test.json
```

Expected: zero errors.

- [ ] **Step 6.5: Run the full notification/attention test suite**

```
pnpm exec jest --ci --runInBand --testPathPattern="modules/(notifications|attention|crm|support)"
```

Expected: all tests pass. The two pre-existing timesheet failures (`period-lifecycle-outbox`, `timesheets-analytics-tenant-isolation`) are not in this path pattern and can be ignored.

---

## Task 7: Generate OpenAPI contract

- [ ] **Step 7.1: Run the generator**

```
pnpm openapi:generate
```

Expected: exits 0.

- [ ] **Step 7.2: Confirm `module_task` appears in `contracts/openapi.json`**

```
grep -c "module_task" contracts/openapi.json
```

Expected: a positive count (multiple occurrences in the discriminated union and source status enum).

- [ ] **Step 7.3: Confirm `task` count field appears**

```
grep -c '"task"' contracts/openapi.json
```

Expected: positive count.

---

## Task 8: Run all verification gates

Run these commands in sequence and record the **real output** to report back.

- [ ] **Step 8.1: Test suite**

```
pnpm exec jest --ci --runInBand --testPathPattern="modules/(notifications|attention|crm|support)"
```

All tests must pass. Tolerated failures: `period-lifecycle-outbox` and `timesheets-analytics-tenant-isolation` only (pre-existing).

- [ ] **Step 8.2: Build typecheck**

```
node --max-old-space-size=10240 ./node_modules/typescript/bin/tsc --noEmit -p tsconfig.build.json
```

Expected: zero errors.

- [ ] **Step 8.3: Test typecheck**

```
node --max-old-space-size=10240 ./node_modules/typescript/bin/tsc --noEmit -p tsconfig.test.json
```

Expected: zero errors.

- [ ] **Step 8.4: ESLint**

```
pnpm exec eslint --quiet src/modules/notifications src/modules/attention src/modules/crm src/modules/support
```

Expected: zero errors.

- [ ] **Step 8.5: Module registration check**

```
pnpm run check:module-registration
```

Expected: passes. A pre-existing `BuildImportExportModule` warning is not yours.

- [ ] **Step 8.6: Permission-keys check**

```
STREAMLINE_FRONTEND_ROOT="D:/projects/personal/Streamlineos/.claude/worktrees/attention-system/frontend" pnpm run check:permission-keys
```

Expected: passes. Both `crm:activities:view` and `support:tickets:view` already exist in both catalogs.

---

## Self-review

### Spec coverage checklist

| Requirement | Task |
|---|---|
| Add `"module_task"` to `INBOX_KINDS` | Task 1 |
| `moduleTaskInboxItemSchema` with `id: z.string()` | Task 1 |
| Add `module_task` to discriminated union | Task 1 |
| `unifiedCountResponseSchema` gains `task` field, `total` includes it | Task 1 |
| Cursor `mt: Record<string, InboxSourcePosition>` | Task 1 |
| Old cursor decodes without `mt`, defaults to `{}` | Task 1 |
| `KIND_ORDER` has `module_task: 4` | Task 2 |
| `lastDeliveredAdapterPositions` generalized to take `trackedKind` | Task 2 |
| `AttentionSourceAdapter` type with `countPending` REQUIRED | Task 3 |
| `AttentionAdapterRegistry` exported from `AttentionModule` | Task 3 |
| CRM adapter — uses `crm:activities:view` permission | Task 4 |
| CRM adapter — deep link `/crm/activities` | Task 4 |
| CRM adapter — leads predicate with `organizationId` tenant column | Task 4 |
| CRM adapter — uses `assigneeUserId` not membershipId | Task 4 |
| CRM adapter — filters `kind = 'task'`, `completedAt IS NULL`, `deletedAt IS NULL` | Task 4 |
| CRM adapter — `supportsAfterCursor: false` (UUID pk) | Task 4 |
| CRM adapter — `taskKind: "crm_task"`, `dedupKey: "task:crm:<id>"` | Task 4 |
| Support adapter — uses `support:tickets:view` permission | Task 5 |
| Support adapter — deep link `/support/inbox` | Task 5 |
| Support adapter — leads predicate with `orgId` tenant column | Task 5 |
| Support adapter — filters open statuses (OPEN, IN_PROGRESS, WAITING) | Task 5 |
| Support adapter — uses `assigneeMembershipId` | Task 5 |
| Support adapter — `supportsAfterCursor: true`, uses `descKeyset` | Task 5 |
| Support adapter — `taskKind: "support_ticket"`, `dedupKey: "task:support:<id>"` | Task 5 |
| Wire `AttentionAdapterRegistry` into `UnifiedInboxService` | Task 6 |
| Same per-adapter permission check via `this.access.holds` | Task 6 |
| Same `readSource` timeout wrapper | Task 6 |
| Same `SourceStatus` reporting | Task 6 |
| Same `resuming && !supportsAfterCursor` handling | Task 6 |
| `module_task` excluded when `triage !== "active"` with correct reason | Task 6 |
| `task` count in `unifiedUnreadCount`, included in `total` | Task 6 |
| `inboxItemKind` handles `module_task` | Task 6 |
| Default `kindsFilter` includes `"module_task"` | Task 6 |
| Regenerate OpenAPI contract | Task 7 |
| Pair every negative assertion with a positive control (BE-141) | All spec files |

### Potential pitfalls

1. **`AttentionFetchResult` type**: Must be defined before `fetchAllAttentionAdapters` in the service file. TypeScript infers the return type through the method; a forward reference to the type within the same file is fine if declared with `type`.

2. **`inArray` import**: The support adapter uses `inArray` from drizzle-orm. Make sure it's imported: `import { and, count, eq, inArray } from "drizzle-orm";`

3. **`descKeyset` order direction**: The support adapter orders newest first by `createdAt DESC`. The `descKeyset` utility produces the correct `(createdAt < at) OR (createdAt = at AND id < id_cursor)` predicate but requires the `orderBy` to match — use `desc(supportTickets.createdAt), desc(supportTickets.id)` not `asc`. Double-check the import: `import { desc } from "drizzle-orm"`.

4. **Module cycle risk**: `CrmAttentionModule` imports `AttentionModule`; `CrmRootModule` imports `CrmAttentionModule`. `AttentionModule` does not import any CRM module. No cycle.

5. **`UnifiedInboxService` constructor length**: NestJS DI by type — adding a 7th `@Inject`-free parameter (`AttentionAdapterRegistry`) works because the class is decorated with `@Injectable()` and the parameter is a concrete injectable class, not an interface. No `@Inject(TOKEN)` needed.

6. **`activities.kind` comparison**: The `kind` column is typed as `text("kind").$type<ActivityKind>()`. Drizzle will use a plain `=` comparison, which is correct. No cast needed.

7. **`supportTickets.status` with `inArray`**: The status column is a pgEnum. `inArray(supportTickets.status, ["OPEN", "IN_PROGRESS", "WAITING"])` works because Drizzle generates `status IN ('OPEN', 'IN_PROGRESS', 'WAITING')` which matches the enum values. The spread `[...OPEN_STATUSES]` converts the readonly tuple to a mutable array as required by `inArray`'s type signature.
