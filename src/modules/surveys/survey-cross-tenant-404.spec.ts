import { NotFoundException } from "@nestjs/common";
import { SurveyVersionService } from "./survey-version.service";
import { SurveyBuilderService } from "./survey-builder.service";
import { SurveyCollectorService } from "./survey-collector.service";
import { SurveyParticipantService } from "./survey-participant.service";
import { SurveyAssessmentService } from "./survey-assessment.service";
import type { Db } from "../../db/drizzle.module";

describe("surveys — a cross-tenant surveyId answers 404, not 500 and not a success", () => {
  const ATTACKER_ORG = "org-attacker";
  const OWNER_ORG = "org-owner";

  function makeDb(surveyRow: { id: number } | undefined) {
    const findFirst = jest.fn().mockResolvedValue(surveyRow);
    return {
      query: {
        surveyForms: { findFirst },
        surveyVersions: { findFirst: jest.fn().mockResolvedValue(undefined) },
        surveyCollectors: { findMany: jest.fn().mockResolvedValue([]) },
        surveyParticipants: { findMany: jest.fn().mockResolvedValue([]) },
        surveyAssessmentAttempts: { findMany: jest.fn().mockResolvedValue([]) },
        surveyCertificates: { findMany: jest.fn().mockResolvedValue([]) },
      },
      insert: jest.fn(() => {
        throw new Error("insert must not be reached for a foreign survey");
      }),
      transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb({})),
    } as unknown as Db;
  }

  it("getDraftVersion refuses a foreign survey instead of inserting a version and raising 23503", async () => {
    const versions = new SurveyVersionService(makeDb(undefined));

    await expect(versions.getDraftVersion(ATTACKER_ORG, 1)).rejects.toThrow(NotFoundException);
  });

  it("getDraftVersion still creates the draft for the owning org (control)", async () => {
    const db = makeDb({ id: 1 });
    const returning = jest.fn().mockResolvedValue([{ id: 7, surveyId: 1 }]);
    const values = jest.fn().mockReturnValue({ returning });
    (db as unknown as { insert: unknown }).insert = jest.fn().mockReturnValue({ values });
    const versions = new SurveyVersionService(db);

    await expect(versions.getDraftVersion(OWNER_ORG, 1)).resolves.toEqual({ id: 7, surveyId: 1 });
  });

  it("reorder refuses a foreign survey", async () => {
    const db = makeDb(undefined);
    const versions = new SurveyVersionService(db);
    const builder = new SurveyBuilderService(db, versions);

    await expect(builder.reorder(ATTACKER_ORG, 1, { sections: [{ id: 1, sortOrder: 0 }] })).rejects.toThrow(
      NotFoundException,
    );
  });

  it("collector list refuses a foreign survey", async () => {
    const collectors = new SurveyCollectorService(makeDb(undefined));

    await expect(collectors.list(ATTACKER_ORG, 1)).rejects.toThrow(NotFoundException);
  });

  it("participant list refuses a foreign survey", async () => {
    const db = makeDb(undefined);
    const participants = new SurveyParticipantService(db);

    await expect(participants.list(ATTACKER_ORG, 1, { page: 1, pageSize: 20 })).rejects.toThrow(NotFoundException);
  });

  it("assessment attempts and certificates refuse a foreign survey", async () => {
    const assessments = new SurveyAssessmentService(makeDb(undefined));

    await expect(assessments.listAttempts(ATTACKER_ORG, 1, { page: 1, pageSize: 20 })).rejects.toThrow(
      NotFoundException,
    );
    await expect(assessments.listCertificates(ATTACKER_ORG, 1)).rejects.toThrow(NotFoundException);
  });
});
