import request from "supertest";
import { eq } from "drizzle-orm";
import { crmMcpSettings, orgModules } from "src/db/schema";
import {
  SEEDED_HARNESS,
  createSeededE2eApp,
  signSeededToken,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";

/**
 * The three MCP tools no end-to-end test has ever executed.
 *
 * The seeded suites call `crm_list_parties`, `crm_list_deals` and
 * `crm_get_deal`. `crm_run_report`, `crm_get_party` and `crm_list_activities`
 * were never invoked by any spec at any level — which is how `crm_run_report`
 * shipped answering 400 to every call it has ever received, for three
 * independent reasons at once, and nobody found out.
 *
 * Every case here goes over HTTP against a real database, because the defect
 * lived in the arguments one service handed another and a mock of the callee
 * cannot see it: the doubles were named for methods the real classes do not
 * have, so the unit suite was green throughout.
 *
 * These deliberately assert on tools returning *no rows*. The bug was never
 * about which rows came back — it was that the call was refused before it could
 * return any — so an empty organisation proves it exactly as well as a seeded
 * one and leaves nothing to keep in sync.
 */
describe(`${SEEDED_HARNESS} CRM MCP tools actually execute`, () => {
  let seeded: SeededE2eApp;
  let fixture: SeededFixture;
  let sessionToken: string;

  beforeAll(async () => {
    seeded = await createSeededE2eApp();

    fixture = await seedOrg(seeded.seedDb)
      .addMember("analyst", {
        permissionKeys: [
          "crm:deals:read",
          "party:parties:view",
          "crm:activities:view",
          /* The MCP tool gate for crm_run_report. */
          "crm:reports:view",
          /*
           * And the reporting module's own admission key. `decideSourceAccess`
           * requires this BEFORE it looks at the source, so without it the tool
           * 403s on a path that never reaches the query compiler — which would
           * hide the very refusal this file is here to prove is gone.
           */
          "crm:reporting:run",
        ],
      })
      .build();

    await seeded.seedDb
      .insert(orgModules)
      .values([{ orgId: fixture.orgId, moduleKey: "crm", enabled: true }]);

    await seeded.seedDb
      .insert(crmMcpSettings)
      .values({ organizationId: fixture.orgId, enabled: true })
      .onConflictDoNothing();

    const analyst = fixture.members.analyst;
    if (!analyst) throw new Error("seed: member 'analyst' missing");
    sessionToken = await signSeededToken(seeded, analyst.userId, fixture.orgId);
  }, 180_000);

  afterAll(async () => {
    if (fixture) {
      await seeded.seedDb
        .delete(orgModules)
        .where(eq(orgModules.orgId, fixture.orgId));
      await seeded.seedDb
        .delete(crmMcpSettings)
        .where(eq(crmMcpSettings.organizationId, fixture.orgId));
      await fixture.teardown();
    }
    await seeded?.close();
  });

  function call(name: string, args: Record<string, unknown>) {
    return request(seeded.app.getHttpServer())
      .post("/crm/mcp/call")
      .set("Authorization", `Bearer ${sessionToken}`)
      .send({ name, arguments: args });
  }

  it("runs a report instead of refusing one", async () => {
    /*
     * The regression in one line. This tool sent `fields` where the description
     * takes `select`, named fields belonging to no source's registry, and left
     * out the required `limit` — so `compileWindow` threw and the caller got a
     * 400 every single time. Three errors, one `as any`, zero coverage.
     */
    const res = await call("crm_run_report", { source: "deals" }).expect(201);

    const payload = JSON.parse(res.body.content[0].text);
    expect(payload).toMatchObject({ rowCount: expect.any(Number) });
    expect(Array.isArray(payload.columns)).toBe(true);
  });

  it("refuses a report source that does not exist, and says which exist", async () => {
    const res = await call("crm_run_report", { source: "payroll_runs" }).expect(400);

    /*
     * The status alone does not discriminate, and I checked rather than assumed:
     * run against the pre-fix service this case passed, because EVERY report
     * call 400ed and an unknown source was simply one more way to get there.
     * A test that passes for the wrong reason is worse than no test, so it
     * asserts the refusal is the one this handler makes — the message names the
     * sources that do exist, which the compiler's own refusal never did.
     */
    expect(JSON.stringify(res.body)).toContain("Valid sources");
    expect(JSON.stringify(res.body)).toMatch(/parties.*deals.*activities/);
  });

  /*
   * A regression guard, not a discriminator — it passes against the pre-fix
   * service too, and is here so the working path stays working. Labelled rather
   * than left to look like it proves more than it does.
   */
  it("reads one party by id", async () => {
    /*
     * A party that is not there answers 404. The point is the 404: the old
     * handler did `String(args.partyId)`, so this route could only ever be
     * reached with a real-looking id, and the missing-id case below could not
     * be reached at all.
     */
    await call("crm_get_party", { partyId: "11111111-1111-4111-8111-111111111111" }).expect(404);
  });

  it("refuses crm_get_party with no partyId rather than looking one up", async () => {
    /*
     * `String(undefined)` is `"undefined"` and truthy, so the old guard passed
     * and the string reached the database as a party id. A 400 here is the
     * whole fix.
     */
    await call("crm_get_party", {}).expect(400);
  });

  /* Also a regression guard: this one path worked before and must keep working. */
  it("reads an activity timeline for a deal", async () => {
    await call("crm_list_activities", { dealId: 1, limit: 5 }).expect(201);
  });

  it("refuses an activity timeline with no anchor", async () => {
    /*
     * Unanchored, the service's anchor falls to `subject_id = ''` and matches
     * nothing, so the old handler returned an empty page that reads as "there is
     * no activity" — a wrong answer rather than a refusal.
     */
    await call("crm_list_activities", {}).expect(400);
  });
});
