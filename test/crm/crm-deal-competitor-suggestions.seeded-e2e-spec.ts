import { randomUUID } from "node:crypto";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import {
  activities,
  crmDealCompetitorSuggestions,
  crmDealCompetitors,
  crmOptions,
  deals,
  orgModules,
} from "src/db/schema";
import {
  SEEDED_HARNESS,
  createSeededE2eApp,
  signSeededToken,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";
import { getPostgresErrorCode } from "src/common/db/postgres-error";

/**
 * CRM-P2-12. The system may notice a competitor. It may not act on noticing.
 *
 * The suite is arranged around the one assertion that matters, which appears in
 * three places on purpose. After a scan, `GET /deals/:dealId/competitors` — the
 * manual list every other CRM surface reads — is still empty. After a refused
 * acceptance, still empty. It fills exactly once: when a named person echoes
 * back the name they were shown.
 *
 * The last test drops out of HTTP and writes SQL, because everything above it
 * proves the service behaves and nothing above it proves the service is the only
 * thing standing there. A future author who wires a sweep to this table will not
 * read this file; they will hit `chk_crm_deal_competitor_suggestions_decided_by_
 * a_person` and get a 23514.
 *
 * Run with:
 *   DATABASE_URL=postgres://owner@host/db \
 *   APP_DATABASE_URL=postgres://streamline_app@host/db \
 *   node --max-old-space-size=12288 ./node_modules/jest/bin/jest.js \
 *     --config ./jest-e2e-seeded.json --forceExit --runInBand \
 *     --testPathPattern=crm-deal-competitor-suggestions
 */

/** Everything the competitor surfaces need, read and write. */
const REP_KEYS = ["crm:deals:read", "crm:deals:update"] as const;

/** May look at the deal and its proposals, may decide nothing. */
const READER_KEYS = ["crm:deals:read"] as const;

/** A Postgres CHECK violation. */
const CHECK_VIOLATION = "23514";

/**
 * The SQLSTATE behind a rejected query.
 *
 * Through `getPostgresErrorCode` rather than off the error directly, because
 * Drizzle wraps driver errors and leaves the code on `.cause`. A spec reading
 * `error.code` would find `undefined`, fail to equal "23514", and be
 * indistinguishable from a spec whose forbidden UPDATE quietly succeeded.
 */
async function sqlstateOf(pending: Promise<unknown>): Promise<string | undefined> {
  try {
    await pending;
    return undefined;
  } catch (error: unknown) {
    return getPostgresErrorCode(error);
  }
}

const COMPETITOR_KEY = "zoho";
const COMPETITOR_LABEL = "Zoho CRM";
const MENTION = "They said Zoho CRM quoted them half of ours.";

describe(`${SEEDED_HARNESS} a noticed competitor is a question, never an answer`, () => {
  let seeded: SeededE2eApp;
  let fixture: SeededFixture;
  let repToken = "";
  let repUserId = "";
  let readerToken = "";
  let dealId = 0;
  let suggestionId = "";

  const api = () => request(seeded.app.getHttpServer());

  /**
   * Accepting is `@Idempotent("crm.deals.competitor_suggestion_accept")`, which
   * makes `Idempotency-Key` a required header: without one the interceptor
   * answers 400 before the handler is entered. Every acceptance below went out
   * bare, so the one case expecting a 400 got its 400 for the wrong reason
   * entirely — a missing header rather than the changed-suggestion refusal it
   * names — and the three expecting the deal to change never reached the
   * handler at all.
   *
   * A fresh key per call, deliberately. A repeated key with the same body
   * replays the stored response and a repeated key with a different body is
   * 422, so sharing one would hide exactly the product rule the "refuses to
   * decide the same suggestion twice" case exists to prove: that the second
   * acceptance is refused by the suggestion's own state, not by the fence in
   * front of it.
   */
  const accept = (token: string) =>
    api()
      .post(`/deals/${dealId}/competitor-suggestions/${suggestionId}/accept`)
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", randomUUID());

  const competitorsOnTheDeal = async (token: string) => {
    const response = await api()
      .get(`/deals/${dealId}/competitors`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    const rows = response.body.data ?? response.body;
    return rows as Array<{ id: string; competitorKey: string }>;
  };

  beforeAll(async () => {
    seeded = await createSeededE2eApp();
    fixture = await seedOrg(seeded.seedDb)
      .addMember("rep", { permissionKeys: [...REP_KEYS] })
      .addMember("reader", { permissionKeys: [...READER_KEYS] })
      .build();

    /** Every deals route carries `@RequireModule("crm")`; without this it is 402. */
    await seeded.seedDb
      .insert(orgModules)
      .values({ orgId: fixture.orgId, moduleKey: "crm", enabled: true })
      .onConflictDoNothing();

    repUserId = fixture.members["rep"]!.userId;
    repToken = await signSeededToken(repUserId, fixture.orgId);
    readerToken = await signSeededToken(
      fixture.members["reader"]!.userId,
      fixture.orgId,
    );

    /**
     * The organisation's curated list. This is the whole vocabulary the matcher
     * is allowed to draw on — nothing here means nothing proposed, which is the
     * point rather than a limitation.
     */
    await seeded.seedDb.insert(crmOptions).values({
      orgId: fixture.orgId,
      type: "competitor",
      key: COMPETITOR_KEY,
      label: COMPETITOR_LABEL,
      sortOrder: 0,
    });

    const [deal] = await seeded.seedDb
      .insert(deals)
      .values({
        orgId: fixture.orgId,
        name: `Competitor probe ${randomUUID().slice(0, 8)}`,
        stage: "qualification",
        assignedToId: repUserId,
      })
      .returning({ id: deals.id });
    dealId = deal!.id;

    await seeded.seedDb.insert(activities).values([
      {
        activityId: randomUUID(),
        organizationId: fixture.orgId,
        kind: "call",
        dealId,
        subject: "Discovery call",
        body: `Budget is signed off. ${MENTION} We meet Friday.`,
        actorKind: "human",
        actorUserId: repUserId,
        occurredAt: new Date(),
      },
      {
        /**
         * A rival nobody has ever entered. It appears in the text and must not
         * appear in the proposals: the matcher recognises names a person
         * maintains, it does not name anything.
         */
        activityId: randomUUID(),
        organizationId: fixture.orgId,
        kind: "note",
        dealId,
        subject: "Notes",
        body: "Also evaluating Pipedrive, apparently.",
        actorKind: "human",
        actorUserId: repUserId,
        occurredAt: new Date(Date.now() - 60_000),
      },
    ]);
  }, 240_000);

  afterAll(async () => {
    if (fixture) {
      await seeded.seedDb
        .delete(crmDealCompetitorSuggestions)
        .where(eq(crmDealCompetitorSuggestions.organizationId, fixture.orgId));
      await seeded.seedDb
        .delete(crmDealCompetitors)
        .where(eq(crmDealCompetitors.orgId, fixture.orgId));
      await seeded.seedDb
        .delete(activities)
        .where(eq(activities.organizationId, fixture.orgId));
      await seeded.seedDb
        .delete(crmOptions)
        .where(eq(crmOptions.orgId, fixture.orgId));
      await seeded.seedDb.delete(deals).where(eq(deals.orgId, fixture.orgId));
      await fixture.teardown();
    }
    await seeded?.close();
  }, 60_000);

  it("proposes what it recognised, and writes nothing to the deal", async () => {
    const response = await api()
      .post(`/deals/${dealId}/competitor-suggestions/scan`)
      .set("Authorization", `Bearer ${repToken}`)
      .expect(200);

    const result = response.body.data ?? response.body;
    expect(result.proposed).toBe(1);
    expect(result.activitiesScanned).toBe(2);
    expect(result.suggestions).toHaveLength(1);

    const [suggestion] = result.suggestions;
    expect(suggestion.competitorKey).toBe(COMPETITOR_KEY);
    expect(suggestion.status).toBe("pending");
    /** Verbatim: the reviewer has to be able to check the claim, not trust it. */
    expect(suggestion.evidenceQuote).toBe(MENTION);
    expect(suggestion.decidedByUserId).toBeNull();
    suggestionId = suggestion.competitorSuggestionId;

    /** The assertion the ticket is about. */
    expect(await competitorsOnTheDeal(repToken)).toHaveLength(0);
  }, 120_000);

  it("re-scanning proposes nothing new and still writes nothing", async () => {
    const response = await api()
      .post(`/deals/${dealId}/competitor-suggestions/scan`)
      .set("Authorization", `Bearer ${repToken}`)
      .expect(200);

    const result = response.body.data ?? response.body;
    expect(result.proposed).toBe(0);
    expect(result.alreadyProposed).toBe(1);
    expect(result.suggestions).toHaveLength(1);
    expect(await competitorsOnTheDeal(repToken)).toHaveLength(0);
  }, 120_000);

  it("refuses an acceptance that echoes a different name, and changes nothing", async () => {
    const response = await accept(repToken)
      .send({ confirmedCompetitorKey: "salesforce" })
      .expect(400);

    expect(JSON.stringify(response.body)).toContain("SUGGESTION_CHANGED");
    expect(await competitorsOnTheDeal(repToken)).toHaveLength(0);

    const [row] = await seeded.seedDb
      .select({ status: crmDealCompetitorSuggestions.status })
      .from(crmDealCompetitorSuggestions)
      .where(
        eq(
          crmDealCompetitorSuggestions.competitorSuggestionId,
          suggestionId,
        ),
      );
    expect(row?.status).toBe("pending");
  }, 120_000);

  it("refuses a reader with no update key, and changes nothing", async () => {
    await api()
      .post(`/deals/${dealId}/competitor-suggestions/scan`)
      .set("Authorization", `Bearer ${readerToken}`)
      .expect(403);

    await accept(readerToken)
      .send({ confirmedCompetitorKey: COMPETITOR_KEY })
      .expect(403);

    /** They may still read the proposal; deciding is what they cannot do. */
    const listed = await api()
      .get(`/deals/${dealId}/competitor-suggestions`)
      .set("Authorization", `Bearer ${readerToken}`)
      .expect(200);
    expect((listed.body.data ?? listed.body).length).toBe(1);

    expect(await competitorsOnTheDeal(repToken)).toHaveLength(0);
  }, 120_000);

  it("writes the competitor exactly once a person confirms the name", async () => {
    const response = await accept(repToken)
      .send({ confirmedCompetitorKey: COMPETITOR_KEY, notes: "Incumbent, renews in March." })
      .expect(200);

    const decided = response.body.data ?? response.body;
    expect(decided.status).toBe("accepted");
    expect(typeof decided.appliedCompetitorId).toBe("string");

    const tracked = await competitorsOnTheDeal(repToken);
    expect(tracked).toHaveLength(1);
    expect(tracked[0]!.competitorKey).toBe(COMPETITOR_KEY);
    /** The pointer resolves: provenance is one join, not a string match. */
    expect(tracked[0]!.id).toBe(decided.appliedCompetitorId);

    const [row] = await seeded.seedDb
      .select({
        status: crmDealCompetitorSuggestions.status,
        decidedByUserId: crmDealCompetitorSuggestions.decidedByUserId,
        decidedAt: crmDealCompetitorSuggestions.decidedAt,
      })
      .from(crmDealCompetitorSuggestions)
      .where(
        eq(crmDealCompetitorSuggestions.competitorSuggestionId, suggestionId),
      );
    expect(row?.status).toBe("accepted");
    /** The row names the person. There is nothing else it could have named. */
    expect(row?.decidedByUserId).toBe(repUserId);
    expect(row?.decidedAt).not.toBeNull();
  }, 120_000);

  it("refuses to decide the same suggestion twice", async () => {
    await accept(repToken)
      .send({ confirmedCompetitorKey: COMPETITOR_KEY })
      .expect(409);

    expect(await competitorsOnTheDeal(repToken)).toHaveLength(1);
  }, 120_000);

  it("never raises a dismissed name again", async () => {
    const dismissedKey = "pipedrive";
    await seeded.seedDb.insert(crmOptions).values({
      orgId: fixture.orgId,
      type: "competitor",
      key: dismissedKey,
      label: "Pipedrive",
      sortOrder: 1,
    });

    const scanned = await api()
      .post(`/deals/${dealId}/competitor-suggestions/scan`)
      .set("Authorization", `Bearer ${repToken}`)
      .expect(200);
    const proposals = (scanned.body.data ?? scanned.body).suggestions as Array<{
      competitorSuggestionId: string;
      competitorKey: string;
    }>;
    const raised = proposals.find((row) => row.competitorKey === dismissedKey);
    expect(raised).toBeDefined();

    await api()
      .post(
        `/deals/${dealId}/competitor-suggestions/${raised!.competitorSuggestionId}/dismiss`,
      )
      .set("Authorization", `Bearer ${repToken}`)
      .send({ reason: "Mentioned in passing, not in the deal." })
      .expect(200);

    const rescanned = await api()
      .post(`/deals/${dealId}/competitor-suggestions/scan`)
      .set("Authorization", `Bearer ${repToken}`)
      .expect(200);
    const after = (rescanned.body.data ?? rescanned.body).suggestions as Array<{
      competitorKey: string;
    }>;
    expect(after.map((row) => row.competitorKey)).not.toContain(dismissedKey);

    /** A dismissal writes nothing to the deal either. */
    expect(await competitorsOnTheDeal(repToken)).toHaveLength(1);
  }, 120_000);

  it("the database refuses an acceptance that names nobody", async () => {
    /**
     * Straight SQL as the owner, bypassing every guard, every DTO and the
     * service that mints the confirmation. This is the layer that survives a
     * refactor: it is not asserting that the code is careful, it is asserting
     * that carelessness does not compile into a row.
     */
    const [pending] = await seeded.seedDb
      .insert(crmDealCompetitorSuggestions)
      .values({
        organizationId: fixture.orgId,
        dealId,
        competitorKey: `probe-${randomUUID().slice(0, 8)}`,
        sourceKind: "activity",
        sourceActivityId: randomUUID(),
        evidenceQuote: "Written by the test, decided by nobody.",
        status: "pending",
      })
      .returning({
        competitorSuggestionId:
          crmDealCompetitorSuggestions.competitorSuggestionId,
      });

    const id = pending!.competitorSuggestionId;

    expect(
      await sqlstateOf(
        seeded.seedDb.execute(
          sql`UPDATE crm_deal_competitor_suggestions
              SET status = 'accepted'
              WHERE competitor_suggestion_id = ${id}`,
        ),
      ),
    ).toBe(CHECK_VIOLATION);

    /** Naming an actor is not enough either — an acceptance must have applied. */
    expect(
      await sqlstateOf(
        seeded.seedDb.execute(
          sql`UPDATE crm_deal_competitor_suggestions
              SET status = 'accepted', decided_by_user_id = ${repUserId}, decided_at = now()
              WHERE competitor_suggestion_id = ${id}`,
        ),
      ),
    ).toBe(CHECK_VIOLATION);

    const [unchanged] = await seeded.seedDb
      .select({ status: crmDealCompetitorSuggestions.status })
      .from(crmDealCompetitorSuggestions)
      .where(
        and(
          eq(crmDealCompetitorSuggestions.organizationId, fixture.orgId),
          eq(crmDealCompetitorSuggestions.competitorSuggestionId, id),
        ),
      );
    expect(unchanged?.status).toBe("pending");
  }, 120_000);
});
