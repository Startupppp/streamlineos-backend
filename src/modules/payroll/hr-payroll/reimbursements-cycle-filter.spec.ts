import type { Db } from "../../../db/drizzle.module";
import { ScopedRead } from "../../access/scoped-read";
import { ReimbursementsService } from "./reimbursements.service";
import { payCycleListQuerySchema } from "./dto/payroll.schemas";

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

function makeDb(): { db: Db; findMany: jest.Mock } {
  const findMany = jest.fn().mockResolvedValue([]);
  const builder = {
    from: jest.fn(),
    where: jest.fn().mockResolvedValue([{ total: 0 }]),
  };
  builder.from.mockReturnValue(builder);
  return {
    db: {
      select: jest.fn().mockReturnValue(builder),
      query: { reimbursements: { findMany } },
    } as unknown as Db,
    findMany,
  };
}

async function whereValues(month?: string): Promise<unknown[]> {
  const { db, findMany } = makeDb();
  const service = new ReimbursementsService(db, {} as never);
  await service.listReimbursements(ScopedRead.of("org-1", "user-1", "all"), 7, 1, 50, month);
  const call = findMany.mock.calls[0]?.[0] as { where?: unknown } | undefined;
  return sqlValues(call?.where);
}

describe("reimbursements list cycle filter", () => {
  it("accepts a YYYY-MM month and rejects anything else", () => {
    expect(payCycleListQuerySchema.parse({ month: "2026-02" }).month).toBe("2026-02");
    expect(payCycleListQuerySchema.safeParse({ month: "2026-13" }).success).toBe(false);
    expect(payCycleListQuerySchema.safeParse({ month: "2026-2" }).success).toBe(false);
    expect(payCycleListQuerySchema.parse({}).month).toBeUndefined();
  });

  it("filters on the booked pay month", async () => {
    const values = await whereValues("2026-02");
    expect(values).toContain("2026-02");
    expect(values).toContain("org-1");
  });

  it("does not constrain the pay month when none is given", async () => {
    expect(await whereValues()).not.toContain("2026-02");
  });
});
