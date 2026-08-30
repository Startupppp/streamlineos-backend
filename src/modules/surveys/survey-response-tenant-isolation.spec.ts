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

describe("SurveyResponseService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  afterEach(() => jest.resetAllMocks());

  function makeService(findMany: jest.Mock) {
    const db = {
      query: { surveyResponseSessions: { findMany, findFirst: jest.fn().mockResolvedValue(null) } },
    } as unknown as Db;
    return new SurveyResponseService(
      db,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
  }

  it("returns empty sessions for a different org (deny: isolation)", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const svc = makeService(findMany);

    const result = await svc.listResponses(ATTACKER_ORG, 1, { page: 1, pageSize: 20 });

    expect(result).toHaveLength(0);
    expect(findMany).toHaveBeenCalledTimes(1);
    const args = findMany.mock.calls[0]?.[0] as { where?: unknown } | undefined;
    expect(sqlValues(args?.where)).toContain(ATTACKER_ORG);
  });

  it("returns sessions for the owning org (control — same-tenant)", async () => {
    const session = { id: 1, orgId: OWNER_ORG, surveyId: 5, status: "submitted" };
    const findMany = jest.fn().mockResolvedValue([session]);
    const svc = makeService(findMany);

    const result = await svc.listResponses(OWNER_ORG, 5, { page: 1, pageSize: 20 });

    expect(result).toHaveLength(1);
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
