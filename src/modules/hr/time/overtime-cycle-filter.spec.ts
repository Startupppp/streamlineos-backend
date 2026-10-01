import type { Db } from "../../../db/drizzle.module";
import { OvertimeService } from "./overtime.service";
import { listQuerySchema } from "./dto/overtime.schemas";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value !== "object") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

function makeDb(): { db: Db; where: jest.Mock } {
  const where = jest.fn();
  const builder = {
    from: jest.fn(),
    where,
    orderBy: jest.fn(),
    limit: jest.fn().mockResolvedValue([]),
  };
  builder.from.mockReturnValue(builder);
  where.mockReturnValue(builder);
  builder.orderBy.mockReturnValue(builder);
  return { db: { select: jest.fn().mockReturnValue(builder) } as unknown as Db, where };
}

describe("overtime list cycle filter", () => {
  it("accepts a YYYY-MM month and rejects anything else", () => {
    expect(listQuerySchema.parse({ month: "2026-02" }).month).toBe("2026-02");
    expect(listQuerySchema.safeParse({ month: "2026-13" }).success).toBe(false);
    expect(listQuerySchema.safeParse({ month: "2026-2" }).success).toBe(false);
    expect(listQuerySchema.safeParse({ month: "2026-02-01" }).success).toBe(false);
    expect(listQuerySchema.parse({}).month).toBeUndefined();
  });

  it("bounds the read to the requested month", async () => {
    const { db, where } = makeDb();
    await new OvertimeService(db, null as never, null as never).listRequests("org-1", {
      pageSize: 10,
      month: "2026-02",
    });
    const values = sqlValues(where.mock.calls[0]?.[0]);
    expect(values).toContain("2026-02-01");
    expect(values).toContain("2026-03-01");
  });

  it("rolls the upper bound into the next year in December", async () => {
    const { db, where } = makeDb();
    await new OvertimeService(db, null as never, null as never).listRequests("org-1", {
      pageSize: 10,
      month: "2026-12",
    });
    const values = sqlValues(where.mock.calls[0]?.[0]);
    expect(values).toContain("2026-12-01");
    expect(values).toContain("2027-01-01");
  });

  it("adds no date bound when no month is given", async () => {
    const { db, where } = makeDb();
    await new OvertimeService(db, null as never, null as never).listRequests("org-1", { pageSize: 10 });
    const values = sqlValues(where.mock.calls[0]?.[0]);
    expect(values).toContain("org-1");
    expect(values.filter((v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v))).toEqual([]);
  });
});
