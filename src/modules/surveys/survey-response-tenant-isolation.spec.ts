import { NotFoundException } from "@nestjs/common";
import { SurveyResponseService } from "./survey-response.service";
import type { Db } from "../../db/drizzle.module";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}


/**
 * `select({ total }).from(t).where(p)` — the COUNT half of the list envelope.
 *
 * It is a second read of the same table, so it is held to the same tenant predicate as the
 * page read: a count that escaped the org scope would disclose another tenant's row count.
 */
function countSelect(total: number) {
  const countWhere = jest.fn();
  const chain: Record<string, unknown> = {
    then: (resolve: (v: unknown) => unknown) => Promise.resolve([{ total }]).then(resolve),
  };
  chain["from"] = jest.fn().mockReturnValue(chain);
  chain["where"] = countWhere.mockReturnValue(chain);
  return { select: jest.fn().mockReturnValue(chain), countWhere };
}

describe("SurveyResponseService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  afterEach(() => jest.resetAllMocks());

  function makeService(findMany: jest.Mock, total = 0) {
    const { select, countWhere } = countSelect(total);
    const db = {
      query: { surveyResponseSessions: { findMany, findFirst: jest.fn().mockResolvedValue(null) } },
      select,
    } as unknown as Db;
    const svc = new SurveyResponseService(
      db,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { svc, countWhere };
  }

  it("returns empty sessions for a different org (deny: isolation)", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const { svc, countWhere } = makeService(findMany);

    const result = await svc.listResponses(ATTACKER_ORG, 1, { page: 1, pageSize: 20 });

    expect(result.items).toHaveLength(0);
    expect(result.total).toBe(0);
    expect(findMany).toHaveBeenCalledTimes(1);
    const args = findMany.mock.calls[0]?.[0] as { where?: unknown } | undefined;
    expect(sqlValues(args?.where)).toContain(ATTACKER_ORG);
    expect(sqlValues(countWhere.mock.calls[0]?.[0])).toContain(ATTACKER_ORG);
  });

  it("returns sessions for the owning org (control — same-tenant)", async () => {
    const session = { id: 1, orgId: OWNER_ORG, surveyId: 5, status: "submitted" };
    const findMany = jest.fn().mockResolvedValue([session]);
    const { svc, countWhere } = makeService(findMany, 1);

    const result = await svc.listResponses(OWNER_ORG, 5, { page: 1, pageSize: 20 });

    expect(result.items).toHaveLength(1);
    expect(result.total).toBe(1);
    expect(sqlValues(countWhere.mock.calls[0]?.[0])).toContain(OWNER_ORG);
  });

  it("throws NotFoundException when response belongs to a different org (cross-tenant isolation)", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const findFirst = jest.fn().mockResolvedValue(null);
    const db = {
      query: { surveyResponseSessions: { findMany, findFirst } },
    } as unknown as Db;
    const svc = new SurveyResponseService(db, {} as never, {} as never, {} as never, {} as never, {} as never);

    await expect(svc.getResponse(ATTACKER_ORG, 1, 99)).rejects.toThrow(NotFoundException);
  });
});
