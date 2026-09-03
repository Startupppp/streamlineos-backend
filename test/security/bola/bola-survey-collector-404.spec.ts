import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { SurveyCollectorService } from "src/modules/surveys/survey-collector.service";
import type { Db } from "src/db/drizzle.module";

/**
 * `POST /surveys/:surveyId/collectors` — found by the live cross-tenant sweep.
 *
 * `create` inserted with the survey id straight from the path and the org from the token, never
 * resolving the survey — while `list` on the same service already called `assertSurveyInOrg`. The
 * composite tenant key `fk_survey_collectors_survey_id_org (org_id, survey_id) ->
 * survey_forms(org_id, id)` refused the row with a 23503 nothing caught, so the route answered
 * **500** where a 404 belongs. Measured control 201, cross-tenant 500.
 */

const CALLER_ORG = "org-b-caller";
const FOREIGN_SURVEY_ID = 4242;
const INPUT = { collectorType: "LINK", name: "n" } as Parameters<SurveyCollectorService["create"]>[2];

function serviceSeeing(surveyRow: { id: number } | undefined): {
  service: SurveyCollectorService;
  inserted: number;
  surveyLookups: unknown[];
} {
  const surveyLookups: unknown[] = [];
  const state = { inserted: 0 };
  const db = {
    query: {
      surveyForms: {
        findFirst: jest.fn().mockImplementation((opts: unknown) => {
          surveyLookups.push((opts as { where?: unknown } | undefined)?.where);
          return Promise.resolve(surveyRow);
        }),
      },
    },
    insert: jest.fn().mockImplementation(() => {
      state.inserted += 1;
      return { values: () => ({ returning: () => Promise.resolve([{ id: 1 }]) }) };
    }),
  } as unknown as Db;
  const service = new SurveyCollectorService(db);
  return {
    service,
    surveyLookups,
    get inserted() {
      return state.inserted;
    },
  };
}

describe("BOLA probe — POST /surveys/:surveyId/collectors", () => {
  it("CROSS-TENANT-MISS: another organisation's survey id is refused", async () => {
    const probe = serviceSeeing(undefined);
    await expect(probe.service.create(CALLER_ORG, FOREIGN_SURVEY_ID, INPUT)).rejects.toThrow(NotFoundException);
  });

  it("EXISTENCE-ORACLE-GUARD: the refusal is NotFound, never Forbidden — and never a 500", async () => {
    const probe = serviceSeeing(undefined);
    const thrown = await probe.service
      .create(CALLER_ORG, FOREIGN_SURVEY_ID, INPUT)
      .catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(NotFoundException);
    expect(thrown).not.toBeInstanceOf(ForbiddenException);
  });

  it("NO-WRITE-ON-MISS: no collector row is inserted, so the FK is never asked to refuse it", async () => {
    const probe = serviceSeeing(undefined);
    await probe.service.create(CALLER_ORG, FOREIGN_SURVEY_ID, INPUT).catch(() => undefined);
    expect(probe.inserted).toEqual(0);
  });

  it("SAME-TENANT: the caller's own survey still gets a collector", async () => {
    const probe = serviceSeeing({ id: FOREIGN_SURVEY_ID });
    await expect(probe.service.create(CALLER_ORG, FOREIGN_SURVEY_ID, INPUT)).resolves.toMatchObject({ id: 1 });
    expect(probe.inserted).toEqual(1);
  });
});
