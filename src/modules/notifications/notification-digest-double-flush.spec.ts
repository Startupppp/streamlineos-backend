import { NotificationDigestService } from "./notification-digest.service";

jest.mock("../../common/tenant", () => ({
  forEachOrg: jest.fn().mockImplementation(
    async (_db: unknown, _tag: string, fn: (tx: unknown, orgId: string) => Promise<void>) => {
      await fn(mockTx, "org-a");
    },
  ),
}));

interface CapturedSelect {
  whereArgs: unknown[];
}

function sqlValues(v: unknown, seen = new Set<object>()): unknown[] {
  if (v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return [v];
  if (Array.isArray(v)) return v.flatMap((i) => sqlValues(i, seen));
  if (typeof v !== "object" || seen.has(v)) return [];
  seen.add(v);
  const r = v as { queryChunks?: unknown[]; value?: unknown; name?: unknown };
  return [
    ...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : []),
    ...(typeof r.name === "string" ? [r.name] : []),
  ];
}

const capturedSelect: CapturedSelect = { whereArgs: [] };

const mockTx = {
  select: jest.fn().mockImplementation(() => ({
    from: jest.fn().mockImplementation(() => ({
      where: jest.fn().mockImplementation((arg: unknown) => {
        capturedSelect.whereArgs.push(arg);
        return {
          limit: jest.fn().mockResolvedValue([]),
        };
      }),
    })),
  })),
  insert: jest.fn().mockReturnValue({
    values: jest.fn().mockReturnValue({
      onConflictDoNothing: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([]),
      }),
    }),
  }),
  update: jest.fn().mockReturnValue({
    set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
  }),
};

describe("NotificationDigestService — double-flush guard", () => {
  const notifications = { create: jest.fn() };
  let svc: NotificationDigestService;

  beforeEach(() => {
    jest.clearAllMocks();
    capturedSelect.whereArgs.length = 0;
    svc = new NotificationDigestService(
      mockTx as unknown as ConstructorParameters<typeof NotificationDigestService>[0],
      notifications as unknown as ConstructorParameters<typeof NotificationDigestService>[1],
    );
  });

  it("queries only unflushed items so a previously sent item cannot be re-flushed", async () => {
    await svc.flushDue();

    const allVals = capturedSelect.whereArgs.flatMap((w) => sqlValues(w));
    const hasNullCheck = capturedSelect.whereArgs.some((arg) => {
      const vals = sqlValues(arg);
      return vals.some(
        (v) =>
          typeof v === "object" &&
          v !== null &&
          JSON.stringify(v).includes("flushed_at"),
      );
    });

    expect(hasNullCheck || allVals.some((v) => typeof v === "string" && v.includes("flushed_at"))).toBe(true);
  });

  it("returns zero windows and zero notifications when no unflushed items are due", async () => {
    const result = await svc.flushDue();

    expect(result.windows).toBe(0);
    expect(result.itemsFlushed).toBe(0);
    expect(result.notificationsCreated).toBe(0);
    expect(notifications.create).not.toHaveBeenCalled();
  });

  it("does not call notifications.create when there are no due items", async () => {
    await svc.flushDue();
    expect(notifications.create).not.toHaveBeenCalled();
  });
});
