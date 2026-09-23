import type { ModuleTaskInboxItem } from "./dto/unified-inbox.schemas";
import { lastDeliveredAdapterPositions } from "./unified-inbox-projections";

function makeModuleTaskItem(
  overrides: Partial<ModuleTaskInboxItem> & Pick<ModuleTaskInboxItem, "id" | "taskKind" | "dedupKey">,
): ModuleTaskInboxItem {
  return {
    kind: "module_task",
    status: "OPEN",
    priority: "MEDIUM",
    dueAt: null,
    body: "test task",
    sourceModule: "test",
    actor: null,
    subject: "Test",
    timestamp: "2026-09-22T10:00:00.000Z",
    isRead: false,
    deepLink: null,
    ...overrides,
  };
}

describe("lastDeliveredAdapterPositions — module_task cursor tracking", () => {
  const SUPPORT_KEY = "support:support_ticket";
  const CRM_KEY = "crm:crm_task";

  const supportItem = makeModuleTaskItem({
    id: "42",
    taskKind: "support_ticket",
    dedupKey: "task:support:42",
    timestamp: "2026-09-22T10:00:00.000Z",
  });

  const crmItem = makeModuleTaskItem({
    id: "550e8400-e29b-41d4-a716-446655440000",
    taskKind: "crm_task",
    dedupKey: "task:crm:550e8400-e29b-41d4-a716-446655440000",
    timestamp: "2026-09-22T09:00:00.000Z",
  });

  const adapterByDedupKey = new Map<string, string>([
    [supportItem.dedupKey, SUPPORT_KEY],
    [crmItem.dedupKey, CRM_KEY],
  ]);

  it("support ticket position IS tracked because its id is a safe integer string", () => {
    const result = lastDeliveredAdapterPositions(
      [supportItem],
      {},
      adapterByDedupKey,
      "module_task",
    );

    expect(result[SUPPORT_KEY]).toEqual({ id: 42, t: supportItem.timestamp });
  });

  it("CRM activity position is NOT tracked because its UUID id is not a safe integer (supportsAfterCursor:false)", () => {
    const result = lastDeliveredAdapterPositions(
      [crmItem],
      {},
      adapterByDedupKey,
      "module_task",
    );

    expect(result[CRM_KEY]).toBeUndefined();
  });

  it("processes both adapters in one page — support advances, CRM is absent", () => {
    const result = lastDeliveredAdapterPositions(
      [supportItem, crmItem],
      {},
      adapterByDedupKey,
      "module_task",
    );

    expect(result[SUPPORT_KEY]).toEqual({ id: 42, t: supportItem.timestamp });
    expect(result[CRM_KEY]).toBeUndefined();
    expect(Object.keys(result)).toHaveLength(1);
  });

  it("merges new positions onto an existing cursor — does not erase prior state", () => {
    const prior = { [SUPPORT_KEY]: { id: 30, t: "2026-09-21T00:00:00.000Z" } };
    const result = lastDeliveredAdapterPositions(
      [supportItem],
      prior,
      adapterByDedupKey,
      "module_task",
    );

    expect(result[SUPPORT_KEY]).toEqual({ id: 42, t: supportItem.timestamp });
  });

  it("items of a different kind are ignored entirely", () => {
    const result = lastDeliveredAdapterPositions(
      [supportItem],
      {},
      adapterByDedupKey,
      "build_approval",
    );

    expect(result).toEqual({});
  });
});
