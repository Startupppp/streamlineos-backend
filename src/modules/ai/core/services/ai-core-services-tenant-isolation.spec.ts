jest.mock("../../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: (_db: unknown, fn: (tx: unknown) => Promise<unknown>, _opts?: unknown) => fn(_db),
  runInNewTenantTransaction: (_db: unknown, _orgId: string, fn: (tx: unknown) => Promise<unknown>) => fn(_db),
}));

import { AiFeedbackService } from "./ai-feedback.service";
import { ChatHistoryService } from "./chat-history.service";
import { AiSummariesService } from "../../summaries/ai-summaries.service";

const ATTACKER_ORG = "org-attacker";
const OWNER_ORG = "org-owner";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

// ---------------------------------------------------------------------------
// AiFeedbackService
// ---------------------------------------------------------------------------

describe("AiFeedbackService — tenant isolation", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("DENY: getSummary scopes query to ATTACKER_ORG only, returns empty", async () => {
    const groupByMock = jest.fn().mockResolvedValue([]);
    const whereMock = jest.fn().mockReturnValue({ groupBy: groupByMock });
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({ where: whereMock }),
      }),
    };

    const service = new AiFeedbackService(db as never);
    const result = await service.getSummary(ATTACKER_ORG);

    const predicate = whereMock.mock.calls[0]?.[0];
    const values = sqlValues(predicate);
    expect(values).toContain(ATTACKER_ORG);
    expect(values).not.toContain(OWNER_ORG);
    expect(result).toEqual([]);
  });

  it("CONTROL: getSummary returns results for OWNER_ORG", async () => {
    const rows = [{ feature: "chat", up: 5, down: 1, total: 6 }];
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({ groupBy: jest.fn().mockResolvedValue(rows) }),
        }),
      }),
    };

    const service = new AiFeedbackService(db as never);
    const result = await service.getSummary(OWNER_ORG);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ feature: "chat", up: 5, down: 1, total: 6, ratio: 0.8333 });
  });
});

// ---------------------------------------------------------------------------
// ChatHistoryService
// ---------------------------------------------------------------------------

describe("ChatHistoryService — tenant isolation", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("DENY: list scopes query to ATTACKER_ORG only, returns empty messages", async () => {
    const whereMock = jest.fn().mockReturnValue({
      orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
    });
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({ where: whereMock }),
      }),
    };

    const service = new ChatHistoryService(db as never);
    const result = await service.list(ATTACKER_ORG, "user-1", 42, { limit: 5 });

    const predicate = whereMock.mock.calls[0]?.[0];
    const values = sqlValues(predicate);
    expect(values).toContain(ATTACKER_ORG);
    expect(values).not.toContain(OWNER_ORG);
    expect(result.messages).toHaveLength(0);
    expect(result.nextCursor).toBeNull();
  });

  it("CONTROL: list returns messages for OWNER_ORG", async () => {
    const rows = [{ id: 1, role: "user", content: "hi", createdAt: new Date() }];
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue(rows) }),
          }),
        }),
      }),
    };

    const service = new ChatHistoryService(db as never);
    const result = await service.list(OWNER_ORG, "user-1", 42, { limit: 5 });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({ id: 1, role: "user", content: "hi" });
    expect(typeof result.messages[0]?.createdAt).toBe("string");
  });

  it("REVOCATION: list scopes to membershipId, not userId", async () => {
    const MEMBERSHIP_ID = 42;
    const whereMock = jest.fn().mockReturnValue({
      orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
    });
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({ where: whereMock }),
      }),
    };

    const service = new ChatHistoryService(db as never);
    await service.list(OWNER_ORG, "user-1", MEMBERSHIP_ID, { limit: 5 });

    const predicate = whereMock.mock.calls[0]?.[0];
    const values = sqlValues(predicate);
    expect(values).toContain(MEMBERSHIP_ID);
  });
});

// ---------------------------------------------------------------------------
// AiSummariesService
// ---------------------------------------------------------------------------

describe("AiSummariesService — tenant isolation", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("DENY: getLatestWithDiff scopes query to ATTACKER_ORG, returns null", async () => {
    const whereMock = jest.fn().mockReturnValue({
      orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
    });
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({ where: whereMock }),
      }),
    };

    const service = new AiSummariesService(db as never);
    const result = await service.getLatestWithDiff(ATTACKER_ORG, "ticket", "t-1");

    const predicate = whereMock.mock.calls[0]?.[0];
    const values = sqlValues(predicate);
    expect(values).toContain(ATTACKER_ORG);
    expect(values).not.toContain(OWNER_ORG);
    expect(result).toBeNull();
  });

  it("CONTROL: getLatestWithDiff returns snapshot with null diff when only one exists", async () => {
    const snapshot = {
      id: 1,
      orgId: OWNER_ORG,
      entityType: "ticket",
      entityId: "t-1",
      summary: "Ticket is on track",
      structured: null,
      citations: null,
      correlationId: null,
      generatedBy: "user-1",
      createdAt: new Date(),
    };
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([snapshot]) }),
          }),
        }),
      }),
    };

    const service = new AiSummariesService(db as never);
    const result = await service.getLatestWithDiff(OWNER_ORG, "ticket", "t-1");

    expect(result).not.toBeNull();
    expect(result?.snapshot).toEqual(snapshot);
    expect(result?.diff).toBeNull();
  });
});
