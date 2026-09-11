import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { SurveyCollectorService } from "src/modules/surveys/survey-collector.service";
import { createCollectorSchema } from "src/modules/surveys/dto/survey-collectors.schemas";
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

/**
 * The request body, parsed through the route's OWN DTO schema, so this probe can only ever send a
 * shape production accepts.
 *
 * This line used to read `{ collectorType: "LINK", … } as Parameters<…>[2]` — a cast onto a value
 * `survey_collector_type` has never had in the enum or the Zod union (`public_link` is the member
 * it meant). `test/` was in no typecheck, so nothing caught it, and the SAME-TENANT control leg was
 * "proving" a collector gets created for a body `createCollectorSchema` (`.strict()`) would have
 * rejected with a 400 long before the service was reached. Parsing the literal here means a rename
 * of that union fails this spec loudly instead of silently un-testing it.
 */
const INPUT = createCollectorSchema.parse({ collectorType: "public_link", name: "n" });

/** Every value bound into a Drizzle SQL fragment, however deeply nested. */
function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

function serviceSeeing(surveyRow: { id: number } | undefined): {
  service: SurveyCollectorService;
  inserted: Record<string, unknown>[];
  surveyLookups: unknown[];
} {
  const surveyLookups: unknown[] = [];
  const inserted: Record<string, unknown>[] = [];
  const db = {
    query: {
      surveyForms: {
        findFirst: jest.fn().mockImplementation((opts: unknown) => {
          surveyLookups.push((opts as { where?: unknown } | undefined)?.where);
          return Promise.resolve(surveyRow);
        }),
      },
    },
    insert: jest.fn().mockImplementation(() => ({
      values: (row: Record<string, unknown>) => {
        inserted.push(row);
        return { returning: () => Promise.resolve([{ id: 1, ...row }]) };
      },
    })),
  } as unknown as Db;
  const service = new SurveyCollectorService(db);
  return { service, surveyLookups, inserted };
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
    expect(probe.inserted).toHaveLength(0);
  });

  it("PREDICATE-SCOPE: the survey is resolved against the CALLER's org, not the path alone", async () => {
    const probe = serviceSeeing(undefined);
    await probe.service.create(CALLER_ORG, FOREIGN_SURVEY_ID, INPUT).catch(() => undefined);
    expect(probe.surveyLookups).toHaveLength(1);
    const bound = sqlValues(probe.surveyLookups[0]);
    expect(bound).toContain(CALLER_ORG);
    expect(bound).toContain(FOREIGN_SURVEY_ID);
  });

  it("SAME-TENANT: the caller's own survey still gets a collector, bound to the caller's org", async () => {
    const probe = serviceSeeing({ id: FOREIGN_SURVEY_ID });
    await expect(probe.service.create(CALLER_ORG, FOREIGN_SURVEY_ID, INPUT)).resolves.toMatchObject({ id: 1 });
    expect(probe.inserted).toHaveLength(1);
    expect(probe.inserted[0]).toMatchObject({
      orgId: CALLER_ORG,
      surveyId: FOREIGN_SURVEY_ID,
      collectorType: INPUT.collectorType,
      name: INPUT.name,
    });
  });
});
