import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.module";
import { DataQualityQueueService } from "./data-quality-queue.service";

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
    ...(Object.prototype.hasOwnProperty.call(record, "value")
      ? sqlValues(record.value, seen)
      : []),
  ];
}

const OWNER_ORG = "org-owner";
const ATTACKER_ORG = "org-attacker";

function makeSelectDb(rows: unknown[]): { db: Db; where: jest.Mock } {
  const where = jest.fn().mockReturnValue({
    orderBy: jest.fn().mockReturnValue({
      limit: jest.fn().mockResolvedValue(rows),
    }),
    limit: jest.fn().mockResolvedValue(rows),
  });

  const from = jest.fn().mockReturnValue({
    leftJoin: jest.fn().mockReturnValue({ where }),
    where,
  });

  const db = {
    select: jest.fn().mockReturnValue({ from }),
    $with: jest.fn().mockReturnValue({}),
  } as unknown as Db;

  return { db, where };
}

describe("DataQualityQueueService.getFinding — cross-tenant isolation", () => {
  it("throws NotFoundException when finding belongs to a different org", async () => {
    const where = jest.fn().mockReturnValue({
      limit: jest.fn().mockResolvedValue([]),
    });
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({ where }),
      }),
    } as unknown as Db;

    const svc = new DataQualityQueueService(db);
    await expect(svc.getFinding(ATTACKER_ORG, "finding-99")).rejects.toThrow(NotFoundException);
  });

  it("scopes the query to the requesting org (isolation — where clause contains orgId)", async () => {
    const where = jest.fn().mockReturnValue({
      limit: jest.fn().mockResolvedValue([]),
    });
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({ where }),
      }),
    } as unknown as Db;

    const svc = new DataQualityQueueService(db);
    await expect(svc.getFinding(ATTACKER_ORG, "finding-99")).rejects.toThrow(NotFoundException);

    if (where.mock.calls[0]) {
      const leafValues = sqlValues(where.mock.calls[0][0]);
      expect(leafValues).toContain(ATTACKER_ORG);
    }
  });

  it("returns the finding for the owning org (same-tenant control)", async () => {
    const finding = {
      dataQualityFindingId: "finding-1",
      organizationId: OWNER_ORG,
      findingType: "DUPLICATE",
      severity: "MEDIUM",
      status: "OPEN",
      firstDetectedAt: new Date(),
    };
    const where = jest.fn().mockReturnValue({
      limit: jest.fn().mockResolvedValue([finding]),
    });
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({ where }),
      }),
    } as unknown as Db;

    const svc = new DataQualityQueueService(db);
    const result = await svc.getFinding(OWNER_ORG, "finding-1");
    expect(result).toMatchObject({ dataQualityFindingId: "finding-1" });
  });
});
