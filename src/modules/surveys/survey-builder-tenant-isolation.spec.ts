import { NotFoundException } from "@nestjs/common";
import { SurveyBuilderService } from "./survey-builder.service";
import { SurveyVersionService } from "./survey-version.service";
import type { Db } from "../../db/drizzle.module";
import { ScopedRead } from "../access/scoped-read";

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

  /**
   * The builder snapshot is the survey's whole content — sections, questions and
   * choices — and it was returned for ANY survey in the organisation under
   * `surveys:view`, a key the catalog marks `scopable`. So a holder narrowed to
   * `own`, whom `GET /surveys/:surveyId` refuses, read every colleague's draft
   * through `GET /surveys/:surveyId/builder`. Caught by
   * `bola-scope-sibling-drift.spec.ts`, whose whole subject is a key whose reads
   * disagree about the scope they apply.
   */
  it("refuses the builder snapshot of a survey the caller's scope excludes", async () => {
    // Empty because the scope predicate did not match the row, which is
    // indistinguishable from the survey not existing — that is the point.
    const getDraftVersion = jest.fn();
    const db = {
      query: { surveyForms: { findFirst: jest.fn().mockResolvedValue(undefined) } },
    } as unknown as Db;
    const svc = new SurveyBuilderService(db, {
      getDraftVersion,
    } as unknown as SurveyVersionService);

    await expect(
      svc.getBuilder(ScopedRead.of(OWNER_ORG, "author-1", "own"), 1),
    ).rejects.toThrow(NotFoundException);
    // Refused before the draft is even located: nothing about the survey leaks
    // through the shape of the failure.
    expect(getDraftVersion).not.toHaveBeenCalled();
  });

  it("builds the snapshot for a caller whose scope does reach the survey (control)", async () => {
    const getDraftVersion = jest.fn().mockResolvedValue({ id: 7 });
    const buildSchemaSnapshot = jest.fn().mockResolvedValue({ sections: [] });
    const db = {
      query: { surveyForms: { findFirst: jest.fn().mockResolvedValue({ id: 1 }) } },
    } as unknown as Db;
    const svc = new SurveyBuilderService(db, {
      getDraftVersion,
      buildSchemaSnapshot,
    } as unknown as SurveyVersionService);

    await expect(
      svc.getBuilder(ScopedRead.of(OWNER_ORG, "author-1", "all"), 1),
    ).resolves.toEqual({ sections: [] });
    expect(buildSchemaSnapshot).toHaveBeenCalledWith(OWNER_ORG, 7);
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
