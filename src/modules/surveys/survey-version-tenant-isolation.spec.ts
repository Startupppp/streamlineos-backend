import { NotFoundException } from "@nestjs/common";
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

describe("SurveyVersionService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  afterEach(() => jest.resetAllMocks());

  it("answers 404 for the draft of a survey owned by a different org and writes nothing", async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const insert = jest.fn();
    const db = {
      query: {
        surveyVersions: { findFirst },
        surveyForms: { findFirst: jest.fn().mockResolvedValue(undefined) },
      },
      insert,
    } as unknown as Db;
    const svc = new SurveyVersionService(db);

    await expect(svc.getDraftVersion(ATTACKER_ORG, 1)).rejects.toThrow(NotFoundException);

    expect(findFirst).toHaveBeenCalledTimes(1);
    const args = findFirst.mock.calls[0]?.[0] as { where?: unknown } | undefined;
    expect(sqlValues(args?.where)).toContain(ATTACKER_ORG);
    expect(insert).not.toHaveBeenCalled();
  });

  it("creates the first draft on the injected db — the request transaction that just inserted the survey — and never opens a second one", async () => {
    const returning = jest.fn().mockResolvedValue([{ id: 99, orgId: OWNER_ORG, surveyId: 1, versionNumber: 1 }]);
    const values = jest.fn().mockReturnValue({ returning });
    const insert = jest.fn().mockReturnValue({ values });
    const transaction = jest.fn(() => {
      throw new Error("a second transaction cannot see the survey row the request transaction just inserted");
    });
    const db = { insert, transaction } as unknown as Db;
    const svc = new SurveyVersionService(db);

    const version = await svc.createDraftVersion(OWNER_ORG, 1);

    expect(version.id).toBe(99);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(values).toHaveBeenCalledWith({ orgId: OWNER_ORG, surveyId: 1, versionNumber: 1 });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("answers 404 for a survey with no draft instead of creating one on a read", async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const insert = jest.fn(() => {
      throw new Error("a read must not write");
    });
    const db = { query: { surveyVersions: { findFirst } }, insert } as unknown as Db;
    const svc = new SurveyVersionService(db);

    await expect(svc.getDraftVersion(OWNER_ORG, 1)).rejects.toThrow(NotFoundException);

    expect(insert).not.toHaveBeenCalled();
  });

  it("returns existing draft for the owning org without creating a new one (control — same-tenant)", async () => {
    const existingDraft = { id: 5, orgId: OWNER_ORG, surveyId: 1, versionNumber: 1, publishedAt: null };
    const findFirst = jest.fn().mockResolvedValue(existingDraft);
    const db = {
      query: { surveyVersions: { findFirst } },
    } as unknown as Db;
    const svc = new SurveyVersionService(db);

    const version = await svc.getDraftVersion(OWNER_ORG, 1);

    expect(version.id).toBe(5);
    expect(findFirst).toHaveBeenCalledTimes(1);
    const args = findFirst.mock.calls[0]?.[0] as { where?: unknown } | undefined;
    expect(sqlValues(args?.where)).toContain(OWNER_ORG);
  });
});
