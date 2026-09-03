import { NotFoundException } from "@nestjs/common";
import { SurveyParticipantService } from "./survey-participant.service";
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

describe("SurveyParticipantService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  afterEach(() => jest.resetAllMocks());

  it("refuses a survey owned by a different org (deny: isolation)", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const db = {
      query: {
        surveyForms: { findFirst: jest.fn().mockResolvedValue(undefined) },
        surveyParticipants: { findMany },
      },
    } as unknown as Db;
    const svc = new SurveyParticipantService(db);

    await expect(svc.list(ATTACKER_ORG, 1, { page: 1, pageSize: 20 })).rejects.toThrow(NotFoundException);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("returns participants for the owning org (control — same-tenant)", async () => {
    const participant = { id: 11, orgId: OWNER_ORG, surveyId: 1, email: "alice@example.com", status: "invited" };
    const findMany = jest.fn().mockResolvedValue([participant]);
    const db = {
      query: {
        surveyForms: { findFirst: jest.fn().mockResolvedValue({ id: 1 }) },
        surveyParticipants: { findMany },
      },
    } as unknown as Db;
    const svc = new SurveyParticipantService(db);

    const result = await svc.list(OWNER_ORG, 1, { page: 1, pageSize: 20 });

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe(11);
  });
});
