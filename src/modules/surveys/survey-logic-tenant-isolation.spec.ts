import { NotFoundException } from "@nestjs/common";
import { SurveyLogicService } from "./survey-logic.service";
import { SurveyVersionService } from "./survey-version.service";
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

describe("SurveyLogicService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";
  const DRAFT = { id: 7, orgId: OWNER_ORG, surveyId: 1 };

  afterEach(() => jest.resetAllMocks());

  function makeVersions(orgId: string): SurveyVersionService {
    return { getDraftVersion: jest.fn().mockResolvedValue({ ...DRAFT, orgId }) } as unknown as SurveyVersionService;
  }

  it("returns empty rules for a different org (deny: isolation)", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const db = {
      query: { surveyLogicRules: { findMany } },
    } as unknown as Db;
    const svc = new SurveyLogicService(db, makeVersions(ATTACKER_ORG));

    const result = await svc.list(ATTACKER_ORG, 1);

    expect(result).toHaveLength(0);
    expect(findMany).toHaveBeenCalledTimes(1);
    const args = findMany.mock.calls[0]?.[0] as { where?: unknown } | undefined;
    expect(sqlValues(args?.where)).toContain(ATTACKER_ORG);
  });

  it("returns rules for the owning org (control — same-tenant)", async () => {
    const rule = { id: 3, orgId: OWNER_ORG, surveyId: 1 };
    const findMany = jest.fn().mockResolvedValue([rule]);
    const db = {
      query: { surveyLogicRules: { findMany } },
    } as unknown as Db;
    const svc = new SurveyLogicService(db, makeVersions(OWNER_ORG));

    const result = await svc.list(OWNER_ORG, 1);

    expect(result).toHaveLength(1);
  });

  it("throws NotFoundException when patching a cross-tenant rule (isolation)", async () => {
    const returning = jest.fn().mockResolvedValue([]);
    const where = jest.fn().mockReturnValue({ returning });
    const set = jest.fn().mockReturnValue({ where });
    const db = {
      update: jest.fn().mockReturnValue({ set }),
    } as unknown as Db;
    const svc = new SurveyLogicService(db, makeVersions(ATTACKER_ORG));

    await expect(svc.patch(ATTACKER_ORG, 1, 99, { sortOrder: 4 })).rejects.toThrow(NotFoundException);
    expect(where).toHaveBeenCalledTimes(1);
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER_ORG);
  });

  /*
   * An all-optional PATCH body that arrives empty takes the read-back branch
   * rather than an UPDATE, so the tenant predicate has to be asserted on a
   * second statement builder. A stub carrying only `update` made this branch
   * die with `this.db.select is not a function` rather than exercise it.
   */
  it("scopes the empty-body read-back to the caller's org (isolation)", async () => {
    const limit = jest.fn().mockResolvedValue([]);
    const where = jest.fn().mockReturnValue({ limit });
    const from = jest.fn().mockReturnValue({ where });
    const db = {
      select: jest.fn().mockReturnValue({ from }),
    } as unknown as Db;
    const svc = new SurveyLogicService(db, makeVersions(ATTACKER_ORG));

    await expect(svc.patch(ATTACKER_ORG, 1, 99, {})).rejects.toThrow(NotFoundException);
    expect(where).toHaveBeenCalledTimes(1);
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER_ORG);
  });

  it("returns the row for an empty body under the owning org (control — same-tenant)", async () => {
    const rule = { id: 99, orgId: OWNER_ORG, surveyId: 1 };
    const limit = jest.fn().mockResolvedValue([rule]);
    const where = jest.fn().mockReturnValue({ limit });
    const from = jest.fn().mockReturnValue({ where });
    const db = {
      select: jest.fn().mockReturnValue({ from }),
    } as unknown as Db;
    const svc = new SurveyLogicService(db, makeVersions(OWNER_ORG));

    await expect(svc.patch(OWNER_ORG, 1, 99, {})).resolves.toEqual(rule);
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(OWNER_ORG);
  });
});
