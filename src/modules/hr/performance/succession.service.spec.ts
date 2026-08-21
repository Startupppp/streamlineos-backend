import { decodeTimestampCursor, encodeTimestampCursor } from "./cursor-pagination";
import { SuccessionService } from "./succession.service";

function primitiveValues(value: unknown, seen = new WeakSet<object>()): unknown[] {
  if (value instanceof Date) return [value];
  if (value === null || typeof value !== "object") return [value];
  if (seen.has(value)) return [];
  seen.add(value);
  return Object.values(value).flatMap((entry) => primitiveValues(entry, seen));
}

function plan(id: number, createdAt: Date) {
  return {
    id,
    orgId: "org-1",
    roleName: `Role ${id}`,
    jobRoleId: null,
    incumbentId: null,
    successorId: `user-${id}`,
    readiness: "ready_now" as const,
    note: null,
    createdBy: null,
    createdAt,
    updatedAt: createdAt,
  };
}

describe("SuccessionService cursor pagination", () => {
  it("applies tenant/keyset predicates, limit+1, and a deterministic next cursor", async () => {
    const boundary = {
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
      recordId: 90,
    };
    const rows = Array.from({ length: 31 }, (_, index) => {
      const createdAt = new Date("2026-06-30T00:00:00.000Z");
      createdAt.setUTCDate(createdAt.getUTCDate() - index);
      return plan(89 - index, createdAt);
    });
    const limit = jest.fn().mockResolvedValue(rows);
    const orderBy = jest.fn(() => ({ limit }));
    const where = jest.fn((_predicate: unknown) => ({ orderBy }));
    const from = jest.fn(() => ({ where }));
    const db = { select: jest.fn(() => ({ from })) };
    const service = new SuccessionService(db as never);

    const result = await service.list("org-1", {
      cursor: encodeTimestampCursor(boundary),
      limit: 30,
    });

    expect(limit).toHaveBeenCalledWith(31);
    expect(orderBy.mock.calls[0]).toHaveLength(2);
    const predicateValues = primitiveValues(where.mock.calls[0][0]);
    expect(predicateValues).toEqual(
      expect.arrayContaining(["org-1", boundary.createdAt, boundary.recordId]),
    );
    expect(result.items).toHaveLength(30);
    expect(result.items).not.toContain(rows[30]);
    expect(decodeTimestampCursor(result.nextCursor!)).toEqual({
      createdAt: rows[29].createdAt,
      recordId: rows[29].id,
    });
  });

  it("returns no cursor when the page has no lookahead row", async () => {
    const row = plan(1, new Date("2026-06-01T00:00:00.000Z"));
    const limit = jest.fn().mockResolvedValue([row]);
    const db = {
      select: () => ({
        from: () => ({ where: () => ({ orderBy: () => ({ limit }) }) }),
      }),
    };
    const service = new SuccessionService(db as never);

    await expect(service.list("org-1", { limit: 30 })).resolves.toEqual({
      items: [row],
      nextCursor: null,
    });
  });
});
