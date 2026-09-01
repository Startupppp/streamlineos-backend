import { BadRequestException, NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import type { AuditService } from "../../../common/audit/audit.service";
import type { CacheService } from "../../../common/cache/cache.service";
import { CoaService } from "./coa.service";
import { DimensionsService } from "./dimensions.service";

type SelectBuilder = {
  from: jest.Mock;
  where: jest.Mock;
  orderBy: jest.Mock;
  limit: jest.Mock;
};

type SelectDb = {
  select: jest.Mock;
  builder: SelectBuilder;
};

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return [value];
  }
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];

  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value")
      ? sqlValues(record.value, seen)
      : []),
  ];
}

function makeSelectDb(rows: unknown[]): SelectDb {
  const builder: SelectBuilder = {
    from: jest.fn(),
    where: jest.fn(),
    orderBy: jest.fn(),
    limit: jest.fn().mockResolvedValue(rows),
  };
  builder.from.mockReturnValue(builder);
  builder.where.mockReturnValue(builder);
  builder.orderBy.mockReturnValue(builder);

  return { select: jest.fn().mockReturnValue(builder), builder };
}

function actor(orgId: string) {
  return { orgId, userId: "user-a" } as Parameters<CoaService["deactivateAccount"]>[0];
}

const cache = {
  cached: jest.fn(),
  invalidate: jest.fn(),
} as unknown as CacheService;
const audit = { log: jest.fn() } as unknown as AuditService;

describe("Accounting settings — cross-tenant isolation", () => {
  it("CoaService hides an account owned by a different org before any mutation", async () => {
    const db = makeSelectDb([]);
    const service = new CoaService(db as unknown as Db, cache, audit);

    await expect(service.deactivateAccount(actor("org-attacker"), 41)).rejects.toThrow(
      NotFoundException,
    );

    expect(db.builder.where).toHaveBeenCalledTimes(1);
    expect(sqlValues(db.builder.where.mock.calls[0]?.[0])).toContain("org-attacker");
  });

  it("DimensionsService hides a dimension owned by a different org before any mutation", async () => {
    const db = makeSelectDb([]);
    const service = new DimensionsService(db as unknown as Db, cache, audit);

    await expect(
      service.updateDimension(actor("org-attacker"), 52, { name: "Changed" }),
    ).rejects.toThrow(NotFoundException);

    expect(db.builder.where).toHaveBeenCalledTimes(1);
    expect(sqlValues(db.builder.where.mock.calls[0]?.[0])).toContain("org-attacker");
  });

  it("rejects more than the bounded number of dimensions instead of truncating", async () => {
    const db = makeSelectDb(Array.from({ length: 101 }, (_, id) => ({ id })));
    const service = new DimensionsService(db as unknown as Db, {
      ...cache,
      cached: jest.fn((_key: string, loader: () => Promise<unknown>) => loader()),
    } as unknown as CacheService, audit);

    await expect(service.listDimensions("org-1")).rejects.toThrow(BadRequestException);
    expect(db.builder.limit).toHaveBeenCalledWith(101);
  });
});
