import { NotFoundException } from "@nestjs/common";
import { makeFakeDb } from "../../test/fake-select-db";
import type { Db } from "../../db/drizzle.module";
import { surveyForms, surveyAssessmentAttempts } from "../../db/schema";
import { SurveyAssessmentService } from "./survey-assessment.service";
import { SurveyLiveSessionService } from "./survey-live-session.service";

const ORG = "org-1";

function survey(overrides: Record<string, unknown>) {
  return {
    id: 1,
    org_id: ORG,
    title: "Survey",
    mode: "assessment",
    status: "published",
    active_version_id: 9,
    settings: {},
    archived_at: null,
    ...overrides,
  };
}

describe("survey participation reads exclude archived surveys", () => {
  it("createAttempt refuses an archived assessment", async () => {
    const db = makeFakeDb(
      { survey_forms: [survey({ id: 1, archived_at: new Date(), status: "archived" })], survey_assessment_attempts: [] },
      { surveyForms, surveyAssessmentAttempts },
    );
    const service = new SurveyAssessmentService(db as unknown as Db);

    await expect(service.createAttempt(ORG, 1, null)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("createAttempt still accepts a live assessment", async () => {
    const db = makeFakeDb(
      { survey_forms: [survey({ id: 1 })], survey_assessment_attempts: [] },
      { surveyForms, surveyAssessmentAttempts },
    );
    const service = new SurveyAssessmentService(db as unknown as Db);

    await expect(service.createAttempt(ORG, 1, null)).resolves.toBeDefined();
  });

  it("live session create refuses an archived survey", async () => {
    const db = makeFakeDb(
      { survey_forms: [survey({ id: 1, archived_at: new Date(), status: "archived" })] },
      { surveyForms },
    );
    const service = new SurveyLiveSessionService(db as unknown as Db);

    await expect(service.create(ORG, 1, "host", {})).rejects.toBeInstanceOf(NotFoundException);
  });

  it("live session create still accepts a live survey", async () => {
    const db = makeFakeDb({ survey_forms: [survey({ id: 1 })] }, { surveyForms });
    const service = new SurveyLiveSessionService(db as unknown as Db);

    await expect(service.create(ORG, 1, "host", {})).resolves.toBeDefined();
  });
});
