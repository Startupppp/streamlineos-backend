import { NotFoundException } from "@nestjs/common";
import { SurveyLogicService } from "./survey-logic.service";
import { SurveyVersionService } from "./survey-version.service";
import type { Db } from "../../db/drizzle.module";
import { ScopedRead } from "../access/scoped-read";
import type { DataScope } from "../access/access.types";

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

  /** `list` now resolves the survey under the caller's scope before reading any rule. */
  const readAs = (orgId: string, scope: DataScope) => ScopedRead.of(orgId, "author-1", scope);

  function dbWith(findMany: jest.Mock, survey: { id: number } | undefined): Db {
    return {
      query: {
        surveyLogicRules: { findMany },
        surveyForms: { findFirst: jest.fn().mockResolvedValue(survey) },
      },
    } as unknown as Db;
  }

  it("returns empty rules for a different org (deny: isolation)", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const db = dbWith(findMany, { id: 1 });
    const svc = new SurveyLogicService(db, makeVersions(ATTACKER_ORG));

    const result = await svc.list(readAs(ATTACKER_ORG, "all"), 1);

    expect(result).toHaveLength(0);
    expect(findMany).toHaveBeenCalledTimes(1);
    const args = findMany.mock.calls[0]?.[0] as { where?: unknown } | undefined;
    expect(sqlValues(args?.where)).toContain(ATTACKER_ORG);
  });

  it("returns rules for the owning org (control — same-tenant)", async () => {
    const rule = { id: 3, orgId: OWNER_ORG, surveyId: 1 };
    const findMany = jest.fn().mockResolvedValue([rule]);
    const db = dbWith(findMany, { id: 1 });
    const svc = new SurveyLogicService(db, makeVersions(OWNER_ORG));

    const result = await svc.list(readAs(OWNER_ORG, "all"), 1);

    expect(result).toHaveLength(1);
  });

  /**
   * `surveys:view` is `scopable`, and the rules carry the survey's question text
   * and its routing. A caller whose scope excludes the survey must be refused
   * here exactly as `GET /surveys/:surveyId` refuses them — the rules were the
   * larger half of the disclosure `bola-scope-sibling-drift.spec.ts` caught.
   */
  it("refuses the rules of a survey the caller's own scope excludes", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    // The survey read comes back empty: the caller's scope predicate did not
    // match it, which is indistinguishable from the survey not existing.
    const db = dbWith(findMany, undefined);
    const svc = new SurveyLogicService(db, makeVersions(OWNER_ORG));

    await expect(svc.list(readAs(OWNER_ORG, "own"), 1)).rejects.toThrow(NotFoundException);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("issues no statement at all at scope none", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const surveyFindFirst = jest.fn();
    const db = {
      query: { surveyLogicRules: { findMany }, surveyForms: { findFirst: surveyFindFirst } },
    } as unknown as Db;
    const svc = new SurveyLogicService(db, makeVersions(OWNER_ORG));

    await expect(svc.list(readAs(OWNER_ORG, "none"), 1)).rejects.toThrow(NotFoundException);
    expect(surveyFindFirst).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
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
