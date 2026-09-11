import request from "supertest";
import { eq } from "drizzle-orm";
import { crmOutboundClassStops, orgModules } from "src/db/schema";
import {
  SEEDED_HARNESS,
  createSeededE2eApp,
  signSeededToken,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";

/**
 * CRM-P0-12. The API smoke behind the class-stops screen.
 *
 * Stopping an outbound message stops that whole class of message for that
 * party, with no expiry — `released_at` is documented as cleared only by a
 * person. Both halves existed on the server and no screen ever called either,
 * so in practice a stop was a one-way door whose only exit was a hand-written
 * UPDATE. This walks the exit end to end, and pins the answers that make it
 * safe to put a button on.
 *
 * Two organisations throughout, because a list of who an organisation has
 * stopped writing to is exactly the sort of thing that must not cross tenants.
 *
 * Run with:
 *   DATABASE_URL=postgres://owner@host/db \
 *   APP_DATABASE_URL=postgres://streamline_app@host/db \
 *   node --max-old-space-size=12288 ./node_modules/jest/bin/jest.js \
 *     --config ./jest-e2e-seeded.json --forceExit --runInBand \
 *     --testPathPattern=crm-class-stops
 */

describe(`${SEEDED_HARNESS} class stops can be seen and released`, () => {
  let seeded: SeededE2eApp;
  let fixture: SeededFixture;
  let other: SeededFixture;

  /** Holds both view and manage. */
  let operatorToken = "";
  /** Holds view only, to prove releasing is the stronger key. */
  let reviewerToken = "";
  /** Another tenant entirely. */
  let strangerToken = "";

  let stopId = "";
  let otherOrgStopId = "";

  const seedStop = async (orgId: string, outboundClass: string): Promise<string> => {
    const [row] = await seeded.seedDb
      .insert(crmOutboundClassStops)
      .values({
        organizationId: orgId,
        partyId: `party-${outboundClass}-${Date.now()}`,
        outboundClass,
        reason: "Asked us to stop",
      })
      .returning({ id: crmOutboundClassStops.outboundClassStopId });
    return row!.id;
  };

  beforeAll(async () => {
    seeded = await createSeededE2eApp();
    fixture = await seedOrg(seeded.seedDb)
      .addMember("operator", {
        permissionKeys: ["crm:autonomy:view", "crm:autonomy:manage"],
      })
      .addMember("reviewer", { permissionKeys: ["crm:autonomy:view"] })
      .build();
    other = await seedOrg(seeded.seedDb)
      .addMember("stranger", {
        permissionKeys: ["crm:autonomy:view", "crm:autonomy:manage"],
      })
      .build();

    for (const orgId of [fixture.orgId, other.orgId]) {
      await seeded.seedDb
        .insert(orgModules)
        .values({ orgId, moduleKey: "crm", enabled: true })
        .onConflictDoNothing();
    }

    operatorToken = await signSeededToken(seeded, fixture.members["operator"]!.userId, fixture.orgId);
    reviewerToken = await signSeededToken(seeded, fixture.members["reviewer"]!.userId, fixture.orgId);
    strangerToken = await signSeededToken(seeded, other.members["stranger"]!.userId, other.orgId);

    stopId = await seedStop(fixture.orgId, "nudge");
    otherOrgStopId = await seedStop(other.orgId, "nudge");
  }, 240_000);

  afterAll(async () => {
    if (fixture) {
      await seeded.seedDb
        .delete(crmOutboundClassStops)
        .where(eq(crmOutboundClassStops.organizationId, fixture.orgId));
      await fixture.teardown();
    }
    if (other) {
      await seeded.seedDb
        .delete(crmOutboundClassStops)
        .where(eq(crmOutboundClassStops.organizationId, other.orgId));
      await other.teardown();
    }
    await seeded?.close();
  }, 60_000);

  const list = (bearer: string) =>
    request(seeded.app.getHttpServer())
      .get("/crm/autonomy/class-stops")
      .set("Authorization", `Bearer ${bearer}`);

  const release = (bearer: string, id: string) =>
    request(seeded.app.getHttpServer())
      .post(`/crm/autonomy/class-stops/${id}/release`)
      .set("Authorization", `Bearer ${bearer}`)
      /** @Idempotent makes this mandatory; without it the route 400s. */
      .set("Idempotency-Key", `release-${id}-${Date.now()}-${Math.random()}`)
      .send({});

  it("lists this organisation's live stops, with what the screen needs to name them", async () => {
    const res = await list(operatorToken);

    expect(res.status).toBe(200);
    const mine = res.body.find(
      (s: { outboundClassStopId: string }) => s.outboundClassStopId === stopId,
    );
    expect(mine).toBeDefined();
    /** The class, because releasing is per class and the operator chooses which. */
    expect(mine.outboundClass).toBe("nudge");
    expect(mine.partyId).toEqual(expect.any(String));
    expect(mine.reason).toBe("Asked us to stop");
  }, 60_000);

  it("does not list another organisation's stops", async () => {
    const res = await list(operatorToken);
    expect(res.status).toBe(200);
    expect(
      res.body.some(
        (s: { outboundClassStopId: string }) => s.outboundClassStopId === otherOrgStopId,
      ),
    ).toBe(false);
  }, 60_000);

  it("refuses to release for a reviewer who may only look", async () => {
    /**
     * Releasing puts a customer back on a list they were taken off. It is
     * deliberately the stronger key, and asserting that here is what stops the
     * screen's button from being the only thing standing in the way.
     */
    const res = await release(reviewerToken, stopId);
    expect(res.status).toBe(403);
  }, 60_000);

  it("answers 404 for another organisation's stop, not 403", async () => {
    /** A 403 would confirm the stop — and therefore the relationship — exists. */
    const res = await release(operatorToken, otherOrgStopId);
    expect(res.status).toBe(404);

    /** And it really was left alone. */
    const [row] = await seeded.seedDb
      .select({ releasedAt: crmOutboundClassStops.releasedAt })
      .from(crmOutboundClassStops)
      .where(eq(crmOutboundClassStops.outboundClassStopId, otherOrgStopId));
    expect(row?.releasedAt).toBeNull();
  }, 60_000);

  it("releases the stop and records who did it", async () => {
    const res = await release(operatorToken, stopId);

    expect(res.status).toBe(201);
    expect(res.body.released).toBe(true);

    const [row] = await seeded.seedDb
      .select({
        releasedAt: crmOutboundClassStops.releasedAt,
        releasedByUserId: crmOutboundClassStops.releasedByUserId,
      })
      .from(crmOutboundClassStops)
      .where(eq(crmOutboundClassStops.outboundClassStopId, stopId));

    expect(row?.releasedAt).not.toBeNull();
    /** Who let this class through again is the question a reviewer asks next. */
    expect(row?.releasedByUserId).toBe(fixture.members["operator"]!.userId);
  }, 60_000);

  it("drops the released stop out of the live list", async () => {
    const res = await list(operatorToken);
    expect(res.status).toBe(200);
    expect(
      res.body.some((s: { outboundClassStopId: string }) => s.outboundClassStopId === stopId),
    ).toBe(false);
  }, 60_000);

  it("answers 409 on a second release, not a silent success", async () => {
    /**
     * "It is released" and "you released it" are different things to tell
     * somebody working out why a customer stopped hearing from them. A 200 here
     * would let two operators each believe they were the one who acted.
     */
    const res = await release(operatorToken, stopId);
    expect(res.status).toBe(409);
  }, 60_000);

  it("lets the other tenant release its own stop", async () => {
    /**
     * The positive half of the isolation assertions above: they fail for the
     * right reason (wrong tenant) rather than because the route is broken.
     */
    const res = await release(strangerToken, otherOrgStopId);
    expect(res.status).toBe(201);
    expect(res.body.released).toBe(true);
  }, 60_000);
});
