import { findStrictParamsDrift, parseParamSchemas, pathParamsOf } from "./strict-params-drift";

/**
 * A `.strict()` `@Validate({ params })` schema that omits a parameter its own path carries.
 *
 * `req.params` holds the parameters of the WHOLE path — the `@Controller` prefix included — so a
 * schema naming only the handler's own segment rejects the parent's as an unrecognised key. The
 * route answers 400 to EVERY caller, its own tenant included, from the validation interceptor
 * before any handler code runs. It is not a tenancy defect; the route simply does not work.
 *
 * WHY THIS LIVES IN THE BOLA HARNESS
 *
 * It was found here, and it was found because the live sweep's own bucketing hid it. 22 of these
 * sat inside the 468 routes filed as "the probe sends no request body" — a label that says a body
 * would fix them. No body fixes them. A control 400 read as "unprobeable" rather than "broken" is
 * how 31 permanently-failing routes stayed invisible to a sweep, to `tsc`, and to the unit suites
 * (`isolatedModules` never runs the interceptor).
 *
 * The findings below are in `src/modules/build/**` — another agent's territory in this release —
 * so they are pinned by name rather than fixed. A NEW one fails this suite; a repaired one is
 * reported, not failed, so the fix is never punished.
 */

/**
 * Every route measured to answer 400 to its own tenant because of this defect.
 *
 * 31, not the 22 the live sweep reached: the other 9 were unprobeable for an unrelated reason
 * (the seed holds no object of that type), which is exactly why a static detector is worth having
 * beside the probe rather than instead of it.
 */
const KNOWN_STRICT_PARAMS_DRIFT: readonly string[] = [
  "DELETE /build/:projectId/bugs/:bugId",
  "DELETE /build/:projectId/decisions/:decisionId",
  "DELETE /build/:projectId/forms/:formId",
  "DELETE /build/:projectId/incidents/:incidentId",
  "DELETE /build/:projectId/risks/:riskId",
  "DELETE /build/:projectId/test-cases/:caseId",
  "DELETE /build/:projectId/test-runs/:runId",
  "DELETE /build/:projectId/test-suites/:suiteId",
  "DELETE /build/:projectId/workflow/transitions/:transitionId",
  "GET /build/:projectId/bugs/:bugId",
  "GET /build/:projectId/decisions/:decisionId",
  "GET /build/:projectId/forms/:formId",
  "GET /build/:projectId/incidents/:incidentId",
  "GET /build/:projectId/risks/:riskId",
  "GET /build/:projectId/test-cases/:caseId",
  "GET /build/:projectId/test-runs/:runId",
  "GET /build/:projectId/workflow/allowed/:fromStatusId",
  "PATCH /build/:projectId/bugs/:bugId",
  "PATCH /build/:projectId/decisions/:decisionId",
  "PATCH /build/:projectId/forms/:formId",
  "PATCH /build/:projectId/forms/:formId/submissions/:submissionId",
  "PATCH /build/:projectId/incidents/:incidentId",
  "PATCH /build/:projectId/risks/:riskId",
  "PATCH /build/:projectId/test-cases/:caseId",
  "PATCH /build/:projectId/test-runs/:runId",
  "PATCH /build/:projectId/test-runs/:runId/results/:resultId",
  "PATCH /build/:projectId/test-suites/:suiteId",
  "PATCH /build/:projectId/workflow/statuses/:statusId/wip",
  "PATCH /build/:projectId/workflow/transitions/:transitionId",
  "POST /build/:projectId/incidents/:incidentId/updates",
  "POST /build/:projectId/test-runs/:runId/results/:resultId/bug",
];

describe("SELF-TEST — the scanner reads schemas and paths the way the interceptor does", () => {
  it("reads the keys of a strict params object", () => {
    const parsed = parseParamSchemas(
      'const bugIdParams = z.object({ bugId: z.coerce.number().int().positive() }).strict();',
    );
    expect(parsed.get("bugIdParams")).toEqual({ keys: ["bugId"], strict: true });
  });

  it("records a non-strict object as non-strict, because it accepts the parent parameter", () => {
    const parsed = parseParamSchemas("const loose = z.object({ bugId: z.string() });");
    expect(parsed.get("loose")).toEqual({ keys: ["bugId"], strict: false });
  });

  it("reads multi-key schemas", () => {
    const parsed = parseParamSchemas(
      'const both = z.object({ projectId: z.coerce.number(), ticketId: z.coerce.number() }).strict();',
    );
    expect(parsed.get("both")?.keys).toEqual(["projectId", "ticketId"]);
  });

  it("takes the path parameters from the whole path, prefix included", () => {
    expect(pathParamsOf("/build/:projectId/bugs/:bugId")).toEqual(["projectId", "bugId"]);
    expect(pathParamsOf("/build/bugs")).toEqual([]);
  });
});

describe("BITE — the detector fires on the defect and stays quiet on the correct shape", () => {
  const write = (source: string): string => {
    const { mkdtempSync, writeFileSync } = jest.requireActual<typeof import("node:fs")>("node:fs");
    const { tmpdir } = jest.requireActual<typeof import("node:os")>("node:os");
    const { join } = jest.requireActual<typeof import("node:path")>("node:path");
    const file = join(mkdtempSync(join(tmpdir(), "bola-strict-")), "x.controller.ts");
    writeFileSync(file, source);
    return file;
  };

  const DEFECT = `
const bugIdParams = z.object({ bugId: z.coerce.number() }).strict();
@Controller("build/:projectId/bugs")
export class BugsController {
  @Get(":bugId")
  @Validate({ params: bugIdParams })
  getBug() {}
}
`;

  it("reports the route whose strict schema omits the controller's own parameter", () => {
    const findings = findStrictParamsDrift([write(DEFECT)]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.route).toBe("GET /build/:projectId/bugs/:bugId");
    expect(findings[0]?.missing).toEqual(["projectId"]);
  });

  it("reports nothing once the parent parameter is named — the fix, not a suppression", () => {
    expect(
      findStrictParamsDrift([
        write(DEFECT.replace("z.object({ bugId: z.coerce.number() })", "z.object({ projectId: z.coerce.number(), bugId: z.coerce.number() })")),
      ]),
    ).toEqual([]);
  });

  it("reports nothing when the schema is not strict, because the extra key is then accepted", () => {
    expect(findStrictParamsDrift([write(DEFECT.replace(".strict()", ""))])).toEqual([]);
  });

  it("reports nothing for a route with no parameter above the handler's own", () => {
    expect(
      findStrictParamsDrift([write(DEFECT.replace('@Controller("build/:projectId/bugs")', '@Controller("build/bugs")'))]),
    ).toEqual([]);
  });
});

describe("the live inventory of routes that 400 to every caller", () => {
  const findings = findStrictParamsDrift();
  const routes = [...new Set(findings.map((f) => f.route))].sort();

  it("ANTI-VACUITY: the scanner sees real controllers, not an empty tree", () => {
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((f) => f.file.startsWith("src/modules/"))).toBe(true);
    expect(findings.every((f) => f.missing.length > 0)).toBe(true);
  });

  /**
   * A repaired route is reported rather than failed — an exact-equality pin turns every fix red and
   * teaches the next person to delete the assertion instead of fixing anything.
   */
  it("no NEW route acquires a strict params schema that omits its own path parameter", () => {
    const healed = KNOWN_STRICT_PARAMS_DRIFT.filter((route) => !routes.includes(route));
    if (healed.length > 0)
      process.stderr.write(
        `[bola-strict-params] ${String(healed.length)} pinned routes are fixed — remove them from ` +
          `KNOWN_STRICT_PARAMS_DRIFT: ${healed.join(", ")}\n`,
      );
    expect(routes.filter((route) => !KNOWN_STRICT_PARAMS_DRIFT.includes(route))).toEqual([]);
  });

  it("RATCHET: the count does not grow", () => {
    process.stderr.write(`[bola-strict-params] ${String(routes.length)} routes answer 400 to every caller\n`);
    expect(routes.length).toBeLessThanOrEqual(KNOWN_STRICT_PARAMS_DRIFT.length);
  });

  /**
   * Named so the shape is legible without reading 31 paths: every one is a QA/governance/forms/
   * workflow sub-controller under `@Controller("build/:projectId/…")` whose id schema forgot the
   * prefix. One is worse — the submissions route omits two.
   */
  it("every finding is under build's :projectId prefix, and one omits two parameters", () => {
    expect(findings.every((f) => f.file.startsWith("src/modules/build/"))).toBe(true);
    const worst = findings.find((f) => f.missing.length > 1);
    expect(worst?.route).toBe("PATCH /build/:projectId/forms/:formId/submissions/:submissionId");
    expect(worst?.missing).toEqual(["projectId", "formId"]);
  });
});
