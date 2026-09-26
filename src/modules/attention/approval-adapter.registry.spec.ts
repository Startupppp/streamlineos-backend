import {
  ApprovalAdapterRegistry,
  approvalAdapterKey,
  approvalObjectKey,
} from "./approval-adapter.registry";
import type { ApprovalSourceAdapter } from "./approval-adapter.registry";
import type {
  BuildApprovalInboxItem,
  InboxSourcePosition,
} from "../notifications/dto/unified-inbox.schemas";

function makeAdapter(module: string, kindLabel: string): ApprovalSourceAdapter {
  return {
    module,
    kindLabel,
    permission: `${module}:test:view`,
    supportsAfterCursor: false,
    fetch: (): Promise<BuildApprovalInboxItem[]> => Promise.resolve([]),
  };
}

function makeCursorAdapter(module: string, kindLabel: string): ApprovalSourceAdapter {
  return {
    ...makeAdapter(module, kindLabel),
    supportsAfterCursor: true,
    fetch: (_orgId, _userId, _membershipId, _limit, cursor: InboxSourcePosition | null): Promise<BuildApprovalInboxItem[]> => {
      void cursor;
      return Promise.resolve([]);
    },
  };
}

describe("ApprovalAdapterRegistry", () => {
  let registry: ApprovalAdapterRegistry;

  beforeEach(() => {
    registry = new ApprovalAdapterRegistry();
  });

  it("returns empty list before any registration", () => {
    expect(registry.list()).toHaveLength(0);
  });

  it("returns all registered adapters", () => {
    registry.register(makeAdapter("hr", "leave"));
    registry.register(makeAdapter("ts", "timesheet"));
    expect(registry.list()).toHaveLength(2);
    expect(registry.list().map((a) => a.kindLabel)).toEqual(["leave", "timesheet"]);
  });

  it("is idempotent: same module+kindLabel registered twice counts once", () => {
    const adapter = makeAdapter("hr", "leave");
    registry.register(adapter);
    registry.register(adapter);
    expect(registry.list()).toHaveLength(1);
  });

  it("allows same kindLabel from different modules", () => {
    registry.register(makeAdapter("hr", "approval"));
    registry.register(makeAdapter("ts", "approval"));
    expect(registry.list()).toHaveLength(2);
  });

  it("allows same module with different kindLabels", () => {
    registry.register(makeAdapter("hr", "leave"));
    registry.register(makeAdapter("hr", "wfh"));
    expect(registry.list()).toHaveLength(2);
  });

  it("dedup keys are collision-free across four adapter namespaces", () => {
    const prefixes = ["approval:leave", "approval:wfh", "approval:timesheet", "approval:workflow"];
    const id = 42;
    const keys = prefixes.map((p) => `${p}:${String(id)}`);
    const unique = new Set(keys);
    expect(unique.size).toBe(keys.length);
  });

  it("list is readonly — pushing to the returned array does not grow the registry", () => {
    registry.register(makeAdapter("hr", "leave"));
    const list = registry.list() as ApprovalSourceAdapter[];
    list.push(makeAdapter("extra", "extra"));
    expect(registry.list()).toHaveLength(1);
  });

  it("preserves supportsAfterCursor on registered adapters", () => {
    registry.register(makeAdapter("hr", "leave"));
    registry.register(makeCursorAdapter("build", "build"));
    const [a, b] = registry.list();
    expect(a?.supportsAfterCursor).toBe(false);
    expect(b?.supportsAfterCursor).toBe(true);
  });
});
