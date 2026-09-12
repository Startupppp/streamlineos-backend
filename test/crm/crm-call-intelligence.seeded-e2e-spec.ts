import { randomUUID } from "node:crypto";
import request from "supertest";
import { eq } from "drizzle-orm";
import { activities, businessParties, orgModules, users } from "src/db/schema";
import {
  callAnalyses,
  callAnalysisRefusals,
  callAnalysisReleases,
  callRecordingConsent,
} from "src/db/schema/crm/call-analysis";
import {
  SEEDED_HARNESS,
  createSeededE2eApp,
  signSeededToken,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";

/**
 * CRM-P2-05 and CRM-P2-06, over real HTTP, real RBAC and real RLS.
 *
 * The unit specs beside the services prove the rules against a database double.
 * This proves the same rules survive the parts a double cannot stand in for: the
 * permission guard resolving `crm:call-analysis:view-team` out of the grant
 * tables, the tenant transaction interceptor setting `app.current_org_id()`, and
 * the RLS policies on `crm_call_analyses` and `crm_call_recording_consent`
 * filtering as the app role rather than as the owner.
 *
 * Two claims, and both are stated as an absence:
 *
 *   1. **A rep's aggregate contains no trace of a colleague.** Not their numbers,
 *      not their name, not their user id, and not a count of their calls. Asserted
 *      by searching the serialised response for the other rep's identifiers, which
 *      is the only form of the assertion that survives somebody adding a field.
 *   2. **A call without consent is never an exemplar.** The unconsented call in
 *      this fixture holds the exact talk ratio the ranking targets, so it is the
 *      call that would come first under any implementation that forgot the gate.
 *
 * Run with:
 *   DATABASE_URL=postgres://owner@host/db \
 *   DIRECT_DATABASE_URL="$DATABASE_URL" \
 *   APP_DATABASE_URL=postgres://streamline_app@host/db \
 *   node --max-old-space-size=12288 ./node_modules/jest/bin/jest.js \
 *     --config ./jest-e2e-seeded.json --forceExit --runInBand \
 *     --testPathPattern=crm-call-intelligence
 */

/** What every CRM member holds. A rep reads their own calls with this alone. */
const REP_KEYS = ["crm:call-analysis:view"] as const;
/** The manager rung, and the exact key `CallCoachingController` gates on. */
const MANAGER_KEYS = ["crm:call-analysis:view", "crm:call-analysis:view-team"] as const;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const REP_A_NAME = "Ana Reyes";
const REP_B_NAME = "Bo Nakamura";

interface SeededCall {
  activityId: string;
  actorUserId: string;
  analysedAt: Date;
  talkRatioBps: number;
  repTurnCount: number;
  repQuestionCount: number;
  nextStepCommitted: boolean;
  /** `null` records no jurisdiction, which the rule reads as all-party. */
  jurisdiction: string | null;
}

describe(`${SEEDED_HARNESS} per-rep call metrics and best-call exemplars`, () => {
  let seeded: SeededE2eApp;
  let fixture: SeededFixture;

  let repAId = "";
  let repBId = "";
  let managerId = "";

  let repAToken = "";
  let repBToken = "";
  let managerToken = "";
  let strangerToken = "";

  const ids = {
    aSettledOne: `call-a1-${randomUUID().slice(0, 8)}`,
    aSettledTwo: `call-a2-${randomUUID().slice(0, 8)}`,
    aNoConsent: `call-a3-${randomUUID().slice(0, 8)}`,
    bSettledOne: `call-b1-${randomUUID().slice(0, 8)}`,
    bSettledTwo: `call-b2-${randomUUID().slice(0, 8)}`,
    bFresh: `call-b3-${randomUUID().slice(0, 8)}`,
  };

  const http = () => request(seeded.app.getHttpServer());

  beforeAll(async () => {
    seeded = await createSeededE2eApp();
    fixture = await seedOrg(seeded.seedDb)
      .addMember("rep-a", { permissionKeys: [...REP_KEYS] })
      .addMember("rep-b", { permissionKeys: [...REP_KEYS] })
      .addMember("manager", { permissionKeys: [...MANAGER_KEYS] })
      /** Holds nothing. Proves the route is gated at all. */
      .addMember("stranger", { permissionKeys: [] })
      .build();

    repAId = fixture.members["rep-a"]!.userId;
    repBId = fixture.members["rep-b"]!.userId;
    managerId = fixture.members["manager"]!.userId;

    /**
     * The seed builder stores identity only, so a name the response is supposed
     * to project has to be put there deliberately. Without this the spec would
     * pass with `repName: null` and would prove nothing about the join that
     * resolves it.
     */
    await seeded.seedDb.update(users).set({ name: REP_A_NAME }).where(eq(users.id, repAId));
    await seeded.seedDb.update(users).set({ name: REP_B_NAME }).where(eq(users.id, repBId));

    /** Every route on this controller carries `@RequireModule("crm")`; without this it is 402. */
    await seeded.seedDb
      .insert(orgModules)
      .values({ orgId: fixture.orgId, moduleKey: "crm", enabled: true })
      .onConflictDoNothing();

    repAToken = await signSeededToken(seeded, repAId, fixture.orgId);
    repBToken = await signSeededToken(seeded, repBId, fixture.orgId);
    managerToken = await signSeededToken(seeded, managerId, fixture.orgId);
    strangerToken = await signSeededToken(seeded, 
      fixture.members["stranger"]!.userId,
      fixture.orgId,
    );

    const now = Date.now();
    const plan: SeededCall[] = [
      {
        activityId: ids.aSettledOne,
        actorUserId: repAId,
        analysedAt: new Date(now - 3 * DAY),
        talkRatioBps: 4000,
        repTurnCount: 12,
        repQuestionCount: 4,
        nextStepCommitted: true,
        jurisdiction: "US-NY",
      },
      {
        activityId: ids.aSettledTwo,
        actorUserId: repAId,
        analysedAt: new Date(now - 2 * DAY),
        talkRatioBps: 4200,
        repTurnCount: 14,
        repQuestionCount: 3,
        nextStepCommitted: false,
        jurisdiction: "US-NY",
      },
      {
        /**
         * The call the exemplar search must never offer. Its talk ratio sits
         * exactly on `EXEMPLAR_TALK_RATIO_TARGET_BPS`, so under any ranking that
         * skipped the consent gate it is the first row of the response.
         */
        activityId: ids.aNoConsent,
        actorUserId: repAId,
        analysedAt: new Date(now - 2 * DAY),
        talkRatioBps: 5000,
        repTurnCount: 20,
        repQuestionCount: 12,
        nextStepCommitted: true,
        jurisdiction: null,
      },
      {
        activityId: ids.bSettledOne,
        actorUserId: repBId,
        analysedAt: new Date(now - 3 * DAY),
        talkRatioBps: 9000,
        repTurnCount: 16,
        repQuestionCount: 1,
        nextStepCommitted: false,
        jurisdiction: "US-NY",
      },
      {
        activityId: ids.bSettledTwo,
        actorUserId: repBId,
        analysedAt: new Date(now - 2 * DAY),
        talkRatioBps: 9200,
        repTurnCount: 18,
        repQuestionCount: 2,
        nextStepCommitted: false,
        jurisdiction: "US-NY",
      },
      {
        /** Analysed an hour ago: still inside Bo's own private window. */
        activityId: ids.bFresh,
        actorUserId: repBId,
        analysedAt: new Date(now - HOUR),
        talkRatioBps: 4900,
        repTurnCount: 22,
        repQuestionCount: 15,
        nextStepCommitted: true,
        jurisdiction: "US-NY",
      },
    ];

    /**
     * Somebody for the reps to have called.
     *
     * `activities` carries `chk_activities_one_anchor` — exactly one of
     * `party_id`, `deal_id`, `subject_id` must be set — so an unanchored call
     * is refused by the database. This fixture inserted one anyway, which meant
     * `beforeAll` threw and all eleven cases in the file reported a hook
     * failure rather than anything about call intelligence.
     *
     * A party is the right anchor: none of `CallAnalysisVisibilityService`'s
     * queries read the anchor at all, so this restores the fixture to something
     * the schema accepts without changing what any assertion is measuring.
     */
    const [callParty] = await seeded.seedDb
      .insert(businessParties)
      .values({ organizationId: fixture.orgId, name: "Northwind Trading" })
      .returning({ partyId: businessParties.partyId });
    if (!callParty) throw new Error("fixture: the party the calls are anchored to was not inserted");

    for (const call of plan) {
      await seeded.seedDb.insert(activities).values({
        activityId: call.activityId,
        organizationId: fixture.orgId,
        kind: "call",
        occurredAt: new Date(call.analysedAt.getTime() - HOUR),
        body: "Rep: hello.\nCustomer: hello.\nRep: shall we?\nCustomer: yes.",
        partyId: callParty.partyId,
        actorKind: "human",
        actorUserId: call.actorUserId,
        source: "manual",
      });

      await seeded.seedDb.insert(callAnalyses).values({
        organizationId: fixture.orgId,
        // Unique per row: the cache key is (org, hash, analyser), and two rows
        // sharing a hash would violate it and lose half the fixture.
        transcriptHash: randomUUID().replace(/-/g, "").repeat(2).slice(0, 64),
        analyzerVersion: 1,
        activityId: call.activityId,
        talkRatioBps: call.talkRatioBps,
        repTurnCount: call.repTurnCount,
        repQuestionCount: call.repQuestionCount,
        objections: [],
        competitorMentions: [],
        nextStepCommitted: call.nextStepCommitted,
        nextStep: call.nextStepCommitted ? "Send the proposal on Friday." : null,
        model: "seeded",
        promptKey: "crm.call-analysis",
        promptVersion: 1,
        transcriptChars: 120,
        createdAt: call.analysedAt,
        updatedAt: call.analysedAt,
      });

      if (call.jurisdiction !== null)
        await seeded.seedDb.insert(callRecordingConsent).values({
          organizationId: fixture.orgId,
          activityId: call.activityId,
          // One-party by the register in `call-recording-consent.ts`, so the
          // jurisdiction alone is sufficient evidence and no attestation of the
          // counterparty's agreement is needed.
          jurisdiction: call.jurisdiction,
          attestedByUserId: managerId,
        });
    }
  /**
   * Ten minutes, against the 240s most seeded specs use.
   *
   * Not because this fixture is heavy — it inserts eighteen rows. The hook boots
   * the whole `AppModule`, and on a machine running several seeded suites at once
   * that boot alone can exceed four minutes, at which point every assertion in
   * the file reports a hook timeout and the suite says nothing at all about the
   * rules it exists to pin. A timeout is a statement about the slowest machine
   * this is allowed to run on, not about the code.
   */
  }, 600_000);

  afterAll(async () => {
    if (fixture) {
      for (const table of [
        callAnalysisRefusals,
        callAnalysisReleases,
        callRecordingConsent,
        callAnalyses,
      ])
        await seeded.seedDb.delete(table).where(eq(table.organizationId, fixture.orgId));
      await seeded.seedDb
        .delete(activities)
        .where(eq(activities.organizationId, fixture.orgId));
      await fixture.teardown();
    }
    await seeded?.close();
  }, 300_000);

  const reps = (token: string, sinceDays = 30) =>
    http()
      .get(`/crm/calls/reps?sinceDays=${sinceDays}`)
      .set("Authorization", `Bearer ${token}`);

  const exemplars = (token: string, metric: string) =>
    http()
      .get(`/crm/calls/exemplars?metric=${metric}&sinceDays=30`)
      .set("Authorization", `Bearer ${token}`);

  it("refuses a member who holds no call-analysis key", async () => {
    await reps(strangerToken).expect(403);
    await exemplars(strangerToken, "talk-ratio").expect(403);
  });

  it("gives a rep their own row and nothing about anybody else", async () => {
    const response = await reps(repAToken).expect(200);

    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].repUserId).toBe(repAId);
    expect(response.body.data[0].repName).toBe(REP_A_NAME);
    expect(response.body.meta.scope).toBe("own");

    /**
     * Ana's two consented calls. The unconsented one is hers and is still
     * excluded — the consent rule is not about who is reading, and a rep does
     * not get to summarise a recording the organisation may not have processed.
     */
    expect(response.body.data[0].callsAnalysed).toBe(2);
    expect(response.body.data[0].medianTalkRatioBps).toBe(4100);
    expect(response.body.meta.consentBlocked).toBe(1);

    /**
     * The leak assertion, made over the whole serialised body rather than field
     * by field. Bo made three calls in this window; if any of them reached the
     * group-by, or if the embargoed total counted them, Bo's id or name would
     * appear somewhere in this string.
     */
    const body = JSON.stringify(response.body);
    expect(body).not.toContain(repBId);
    expect(body).not.toContain(REP_B_NAME);
    expect(body).not.toContain(ids.bSettledOne);
    expect(response.body.meta.embargoed).toBe(0);
  });

  it("lets the other rep read their own call inside its private window", async () => {
    const response = await reps(repBToken).expect(200);

    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].repUserId).toBe(repBId);
    // All three, including the one analysed an hour ago: the rule's first clause
    // is that the rep who was on the call always reads it.
    expect(response.body.data[0].callsAnalysed).toBe(3);
    expect(response.body.data[0].embargoed).toBe(0);

    expect(JSON.stringify(response.body)).not.toContain(repAId);
  });

  it("gives a manager both reps, and still withholds the call Bo has not read", async () => {
    const response = await reps(managerToken).expect(200);

    expect(response.body.meta.scope).toBe("team");
    expect(response.body.data.map((row: { repUserId: string }) => row.repUserId).sort()).toEqual(
      [repAId, repBId].sort(),
    );

    const bo = response.body.data.find((row: { repUserId: string }) => row.repUserId === repBId);
    expect(bo.callsAnalysed).toBe(2);
    expect(bo.embargoed).toBe(1);
    /**
     * 9100 is the median of Bo's two settled calls. The fresh one sits at 4900,
     * so counting it would drop the median to 9000 — a plausible number that no
     * reviewer would question, which is why the fixture makes the difference
     * large enough for the assertion to be real.
     */
    expect(bo.medianTalkRatioBps).toBe(9100);
    expect(response.body.meta.embargoed).toBe(1);
    expect(response.body.meta.privateWindowHours).toBe(24);
  });

  it("returns a trend whose buckets cover the window and whose width it names", async () => {
    const response = await reps(repAToken, 7).expect(200);

    expect(response.body.meta.bucket).toBe("day");
    expect(response.body.data[0].trend).toHaveLength(7);

    const counted = response.body.data[0].trend.reduce(
      (total: number, point: { calls: number }) => total + point.calls,
      0,
    );
    expect(counted).toBe(response.body.data[0].callsAnalysed);
  });

  it("never offers a call without consent as an exemplar, whatever the metric", async () => {
    for (const metric of ["talk-ratio", "question-rate", "next-step"]) {
      const response = await exemplars(managerToken, metric).expect(200);
      const returned = response.body.data.map((row: { activityId: string }) => row.activityId);

      /**
       * The unconsented call holds the target talk ratio, the highest question
       * rate in the fixture and a committed next step. It is absent from all
       * three lists, and its absence is reported as `consentBlocked` rather than
       * being silently dropped.
       */
      expect(returned).not.toContain(ids.aNoConsent);
      expect(response.body.meta.consentBlocked).toBe(1);
    }
  });

  it("ranks a talk-ratio exemplar by closeness to the target, not by the largest number", async () => {
    const response = await exemplars(managerToken, "talk-ratio").expect(200);
    const returned = response.body.data.map((row: { activityId: string }) => row.activityId);

    // Ana's 4000/4200 are nearer 5000 than Bo's 9000/9200, and Bo's 4900 is
    // nearer still but is embargoed. A descending sort on the raw metric would
    // have put Bo's monologues first.
    expect(returned[0]).toBe(ids.aSettledTwo);
    expect(returned).not.toContain(ids.bFresh);
    expect(response.body.meta.talkRatioTargetBps).toBe(5000);
    expect(response.body.meta.embargoed).toBe(1);
  });

  it("offers a rep only their own calls as exemplars, and no count of anyone else's", async () => {
    const response = await exemplars(repAToken, "talk-ratio").expect(200);
    const returned = response.body.data.map((row: { activityId: string }) => row.activityId);

    expect(returned.sort()).toEqual([ids.aSettledOne, ids.aSettledTwo].sort());
    expect(response.body.meta.scope).toBe("own");
    expect(response.body.meta.embargoed).toBe(0);
    expect(JSON.stringify(response.body)).not.toContain(repBId);
  });

  it("carries no verbatim customer speech on an exemplar row", async () => {
    const response = await exemplars(managerToken, "next-step").expect(200);

    expect(response.body.data.length).toBeGreaterThan(0);
    for (const row of response.body.data) {
      // The list is a pointer. Quotes, objections and the next-step sentence all
      // live behind `GET /crm/calls/:activityId/analysis`, which applies the
      // visibility rule again on its own terms.
      expect(row).not.toHaveProperty("nextStep");
      expect(row).not.toHaveProperty("objections");
      expect(row).not.toHaveProperty("competitorMentions");
    }
  });

  it("caps the page size at the platform limit rather than honouring a larger one", async () => {
    await http()
      .get("/crm/calls/reps?limit=500")
      .set("Authorization", `Bearer ${managerToken}`)
      .expect(400);
  });

  it("refuses an unknown query parameter instead of ignoring it", async () => {
    /**
     * `.strict()` on the DTO. A request carrying `repUserId=<somebody else>`
     * must fail rather than be stripped and answered, or the next author will
     * believe a widening parameter exists and works.
     */
    await http()
      .get(`/crm/calls/reps?repUserId=${repBId}`)
      .set("Authorization", `Bearer ${managerToken}`)
      .expect(400);
  });
});
