import { NotFoundException } from "@nestjs/common";
import { SurveyBuilderService } from "./survey-builder.service";
import { SurveyVersionService } from "./survey-version.service";
import type { Db } from "../../db/drizzle.module";

describe("SurveyBuilderService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  afterEach(() => jest.resetAllMocks());

  function makeVersionsMock() {
    return {} as SurveyVersionService;
  }

  it("throws NotFoundException when section belongs to a different org (cross-tenant isolation)", async () => {
    const returning = jest.fn().mockResolvedValue([]);
    const where = jest.fn().mockReturnValue({ returning });
    const set = jest.fn().mockReturnValue({ where });
    const db = {
      update: jest.fn().mockReturnValue({ set }),
    } as unknown as Db;
    const svc = new SurveyBuilderService(db, makeVersionsMock());

    await expect(svc.patchSection(ATTACKER_ORG, 1, 99, { title: "hack" })).rejects.toThrow(NotFoundException);
  });

  it("throws NotFoundException when question belongs to a different org (cross-tenant isolation)", async () => {
    const db = {
      query: { surveyQuestions: { findFirst: jest.fn().mockResolvedValue(null) } },
    } as unknown as Db;
    const svc = new SurveyBuilderService(db, makeVersionsMock());

    await expect(svc.getQuestion(ATTACKER_ORG, 99)).rejects.toThrow(NotFoundException);
  });

  it("returns question for the owning org (control — same-tenant)", async () => {
    const question = { id: 99, orgId: OWNER_ORG, choices: [] };
    const db = {
      query: { surveyQuestions: { findFirst: jest.fn().mockResolvedValue(question) } },
    } as unknown as Db;
    const svc = new SurveyBuilderService(db, makeVersionsMock());

    const result = await svc.getQuestion(OWNER_ORG, 99);

    expect(result.id).toBe(99);
  });
});
