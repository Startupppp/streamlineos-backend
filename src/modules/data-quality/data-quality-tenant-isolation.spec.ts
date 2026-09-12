import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.module";
import { DataQualityQueueService } from "./data-quality-queue.service";
import { countOpenInGroup, selectCandidates } from "./lib/finding-selection";

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

/**
 * The bulk-selection path, which nothing pinned until now.
 *
 * `selectCandidates` is where a caller's selection — a list of identifiers or a
 * group key — becomes the rows a bulk decision then resolves, merges or assigns.
 * Its tenant predicate is therefore the gate on the highest-consequence path in
 * this module, and it was untested: replacing `organizationId` with a literal
 * inside it left all 102 tests in `src/modules/data-quality` green. That
 * mutation now fails on the three assertions below.
 *
 * Every one asserts the `where` was actually called before inspecting it. The
 * older test above guards its assertion with `if (where.mock.calls[0])`, which
 * passes silently when the query never ran — the failure mode a mock-driven
 * isolation test has to rule out first.
 */
describe("finding-selection — cross-tenant isolation", () => {
  it("scopes an identifier selection to the caller's org", async () => {
    const { db, where } = makeSelectDb([]);

    await selectCandidates({ db }, ATTACKER_ORG, { kind: "ids", findingIds: ["f-1"] }, "open");

    expect(where).toHaveBeenCalledTimes(1);
    const leaves = sqlValues(where.mock.calls[0]![0]);
    expect(leaves).toContain(ATTACKER_ORG);
    expect(leaves).not.toContain(OWNER_ORG);
  });

  /**
   * The group arm matters on its own: a group key is not tenant-scoped by
   * itself, so two organisations filing the same class of problem produce the
   * same `groupKey`, and the org predicate is the only thing separating them.
   */
  it("scopes a group selection to the caller's org", async () => {
    const { db, where } = makeSelectDb([]);

    await selectCandidates(
      { db },
      ATTACKER_ORG,
      { kind: "group", groupKey: "duplicate-parties" },
      "open",
    );

    expect(where).toHaveBeenCalledTimes(1);
    const leaves = sqlValues(where.mock.calls[0]![0]);
    expect(leaves).toContain(ATTACKER_ORG);
    expect(leaves).toContain("duplicate-parties");
    expect(leaves).not.toContain(OWNER_ORG);
  });

  it("scopes the remaining-in-group count to the caller's org", async () => {
    const where = jest.fn().mockResolvedValue([{ n: 0 }]);
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({ where }),
      }),
    } as unknown as Db;

    await countOpenInGroup({ db }, ATTACKER_ORG, "duplicate-parties");

    expect(where).toHaveBeenCalledTimes(1);
    const leaves = sqlValues(where.mock.calls[0]![0]);
    expect(leaves).toContain(ATTACKER_ORG);
    expect(leaves).not.toContain(OWNER_ORG);
  });
});
