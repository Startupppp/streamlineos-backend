import { randomUUID } from "node:crypto";
import request from "supertest";
import { eq } from "drizzle-orm";
import { crmSegments, orgModules, users } from "src/db/schema";
import { businessParties } from "src/db/schema/party";
import {
  SEEDED_HARNESS,
  createSeededE2eApp,
  signSeededToken,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";

/**
 * CRM-P2-01, over real HTTP and real RLS.
 *
 * The claim this module makes is not that it can store a filter — anything can
 * store a filter. It is that a segment is **evaluated on read** and therefore
 * cannot be stale, and that a person holding the segment keys and nothing else
 * cannot use one to read the customers whose own screen refuses them. Neither
 * claim is provable against a mock: the first needs a real row inserted between
 * two real reads, and the second needs the real permission resolver, the real
 * guard chain and the real tenant transaction.
 *
 * The test that matters is "the answer moves when the data moves". Everything
 * else here is the supporting cast for it.
 *
 * Run with:
 *   DATABASE_URL=postgres://owner@host/db \
 *   APP_DATABASE_URL=postgres://streamline_app@host/db \
 *   node --max-old-space-size=12288 ./node_modules/jest/bin/jest.js \
 *     --config ./jest-e2e-seeded.json --forceExit --runInBand \
 *     --testPathPattern=crm-segments
 */

/** Everything the surface needs, including the key that governs the rows. */
const MARKETER_KEYS = [
  "crm:segments:view",
  "crm:segments:manage",
  "party:parties:view",
] as const;

/** Everything except the key that governs the rows. */
const NO_SOURCE_KEYS = ["crm:segments:view", "crm:segments:manage"] as const;

const MARKETER_NAME = "Ishaan Marketer";

const TEXTILES_CRITERIA = {
  kind: "and" as const,
  nodes: [
    { kind: "compare" as const, field: "industry", operator: "eq" as const, value: "Textiles" },
    {
      kind: "compare" as const,
      field: "name",
      operator: "starts_with" as const,
      value: "Segment probe",
    },
  ],
};

describe(`${SEEDED_HARNESS} a segment is re-evaluated, never remembered`, () => {
  let seeded: SeededE2eApp;
  let fixture: SeededFixture;
  let marketerToken = "";
  let strangerToken = "";
  let segmentId = "";
  const segmentName = `Textile customers ${randomUUID().slice(0, 8)}`;

  const api = () => request(seeded.app.getHttpServer());

  const seedParty = async (
    industry: string,
    options: { deleted?: boolean } = {},
  ): Promise<void> => {
    await seeded.seedDb.insert(businessParties).values({
      partyId: randomUUID(),
      organizationId: fixture.orgId,
      name: `Segment probe ${randomUUID().slice(0, 8)}`,
      industry,
      ...(options.deleted ? { deletedAt: new Date() } : {}),
    });
  };

  beforeAll(async () => {
    seeded = await createSeededE2eApp();
    fixture = await seedOrg(seeded.seedDb)
      .addMember("marketer", { permissionKeys: [...MARKETER_KEYS] })
      .addMember("stranger", { permissionKeys: [...NO_SOURCE_KEYS] })
      .build();

    const marketer = fixture.members["marketer"]!;
    /**
     * The seed builder stores identity only, so the name the list projects has
     * to be put there deliberately — otherwise this spec passes with the join
     * returning null and proves nothing about it.
     */
    await seeded.seedDb
      .update(users)
      .set({ name: MARKETER_NAME })
      .where(eq(users.id, marketer.userId));

    /** Every CRM route carries `@RequireModule("crm")`; without this it is 402. */
    await seeded.seedDb
      .insert(orgModules)
      .values({ orgId: fixture.orgId, moduleKey: "crm", enabled: true })
      .onConflictDoNothing();

    marketerToken = await signSeededToken(marketer.userId, fixture.orgId);
    strangerToken = await signSeededToken(
      fixture.members["stranger"]!.userId,
      fixture.orgId,
    );

    await seedParty("Textiles");
    await seedParty("Textiles");
    await seedParty("Logistics");
    /**
     * A soft-deleted customer in the segment's own band. Nothing in the stored
     * criteria excludes it — the registry declares the soft-delete column and
     * the compiler appends the predicate — so if this row ever appears in a
     * count or a member list, a deleted customer has been disclosed.
     */
    await seedParty("Textiles", { deleted: true });
    /**
     * Longer than the 240s the neighbouring CRM specs allow. Booting the app and
     * seeding an organisation is the same work here; what differs is that these
     * suites are run several at a time against one local Postgres, and a hook
     * that gives up under contention reports eleven assertion failures for a
     * queue.
     */
  }, 600_000);

  afterAll(async () => {
    if (fixture) {
      await seeded.seedDb
        .delete(crmSegments)
        .where(eq(crmSegments.organizationId, fixture.orgId));
      await seeded.seedDb
        .delete(businessParties)
        .where(eq(businessParties.organizationId, fixture.orgId));
      await fixture.teardown();
    }
    await seeded?.close();
  }, 60_000);

  it("offers only what this caller could evaluate", async () => {
    const response = await api()
      .get("/crm/segments/sources")
      .set("Authorization", `Bearer ${marketerToken}`)
      .expect(200);

    const sources = response.body.data ?? response.body;
    expect(sources.map((source: { key: string }) => source.key)).toEqual(["parties"]);
    const names = sources[0].fields.map((field: { name: string }) => field.name);
    expect(names).toContain("industry");
    expect(names).toContain("lifecycle_stage");
  }, 120_000);

  it("answers a preview with a count and refuses to hand back the rows", async () => {
    /**
     * The line between this module and reporting. A preview that returned rows
     * would be an ad-hoc query endpoint with no saved artefact and no audit
     * row, which is `POST /crm/reporting/run` — and duplicating that is how a
     * second query engine arrives, one convenience at a time.
     */
    const response = await api()
      .post("/crm/segments/preview")
      .set("Authorization", `Bearer ${marketerToken}`)
      .send({ source: "parties", criteria: TEXTILES_CRITERIA })
      .expect(201);

    const body = response.body.data ?? response.body;
    expect(body.total).toBe(2);
    expect(body.rows).toBeUndefined();
  }, 120_000);

  it("saves the criteria and hands back the row the builder reopens", async () => {
    const response = await api()
      .post("/crm/segments")
      .set("Authorization", `Bearer ${marketerToken}`)
      .send({
        name: segmentName,
        description: "Textile accounts we address as one group.",
        source: "parties",
        criteria: TEXTILES_CRITERIA,
      })
      .expect(201);

    const body = response.body.data ?? response.body;
    expect(typeof body.segmentId).toBe("string");
    expect(body.sourceKey).toBe("parties");
    /** The criteria round-trip, because that is what a reopen puts in the form. */
    expect(body.criteria).toEqual(TEXTILES_CRITERIA);
    segmentId = body.segmentId;
  }, 120_000);

  it("lists it with the author as a name rather than an id", async () => {
    const response = await api()
      .get("/crm/segments?limit=25&offset=0")
      .set("Authorization", `Bearer ${marketerToken}`)
      .expect(200);

    const rows = response.body.data ?? response.body;
    const saved = rows.find((row: { segmentId: string }) => row.segmentId === segmentId);

    expect(saved).toBeDefined();
    expect(saved.createdByName).toBe(MARKETER_NAME);
    /** The list projects no criteria tree; that is the detail read's job. */
    expect(saved.criteria).toBeUndefined();
  }, 120_000);

  it("returns members and the exact size, and excludes soft-deleted rows", async () => {
    const response = await api()
      .get(`/crm/segments/${segmentId}/members?limit=100`)
      .set("Authorization", `Bearer ${marketerToken}`)
      .expect(200);

    const body = response.body.data ?? response.body;
    /**
     * Two, not three. The fourth Textiles party is soft-deleted and matches
     * every stored criterion; it is absent because the compiler appends the
     * registry's soft-delete predicate, not because the criteria mention it.
     */
    expect(body.total).toBe(2);
    expect(body.rows).toHaveLength(2);
    expect(body.truncated).toBe(false);
    expect(body.columns[0].projection).toEqual({ kind: "field", field: "name" });
  }, 120_000);

  it("moves when the data moves, with nothing refreshed in between", async () => {
    /**
     * The claim the whole design exists to make. A materialised membership
     * would answer 2 here and go on answering 2 until some sweep nobody watches
     * ran again; the user who just created the customer would be told, by a
     * screen whose job is to be true, that it is not in the segment.
     *
     * No endpoint is called to reconcile anything between the two reads. The
     * only thing that happens is a row appearing in `business_parties`.
     */
    await seedParty("Textiles");

    const response = await api()
      .get(`/crm/segments/${segmentId}/members?limit=100`)
      .set("Authorization", `Bearer ${marketerToken}`)
      .expect(200);

    const body = response.body.data ?? response.body;
    expect(body.total).toBe(3);
    expect(body.rows).toHaveLength(3);
  }, 120_000);

  it("refuses the segment keys alone as a way into the rows", async () => {
    /**
     * The module's safety argument. `crm:segments:view` says a person may work
     * with segments, not which data they may read. Without `party:parties:view`
     * a segment must not become the way to count and list the customers the
     * parties screen refuses.
     */
    await api()
      .post("/crm/segments/preview")
      .set("Authorization", `Bearer ${strangerToken}`)
      .send({ source: "parties", criteria: TEXTILES_CRITERIA })
      .expect(403);

    await api()
      .get(`/crm/segments/${segmentId}/members?limit=10`)
      .set("Authorization", `Bearer ${strangerToken}`)
      .expect(403);

    await api()
      .post("/crm/segments")
      .set("Authorization", `Bearer ${strangerToken}`)
      .send({
        name: `Refused ${randomUUID().slice(0, 8)}`,
        source: "parties",
        criteria: TEXTILES_CRITERIA,
      })
      .expect(403);
  }, 120_000);

  it("refuses a source that is not segmentable, and a field the registry withholds", async () => {
    /**
     * `deals` is in the reporting registry and deliberately not segmentable —
     * a saved, named set of deals is a report. 400 rather than 403, because no
     * permission would grant it.
     */
    await api()
      .post("/crm/segments/preview")
      .set("Authorization", `Bearer ${marketerToken}`)
      .send({
        source: "deals",
        criteria: { kind: "compare", field: "stage", operator: "eq", value: "WON" },
      })
      .expect(400);

    /**
     * `tax_number` is a real column on `business_parties` and is deliberately
     * absent from the registry: a filterable identifier column turns a counting
     * surface into an extraction one. The refusal proves the registry is the
     * allow-list rather than the schema.
     */
    await api()
      .post("/crm/segments/preview")
      .set("Authorization", `Bearer ${marketerToken}`)
      .send({
        source: "parties",
        criteria: { kind: "compare", field: "tax_number", operator: "eq", value: "AAAAA0000A" },
      })
      .expect(400);
  }, 120_000);

  it("refuses a second segment with the same name", async () => {
    /**
     * Two segments called the same thing that return different sets is how a
     * disagreement in a meeting becomes unresolvable. 409 and not an unhandled
     * 500, which needs the SQLSTATE read off the cause chain — Drizzle wraps
     * driver errors, so `error.code === "23505"` on the thrown object is always
     * false.
     */
    await api()
      .post("/crm/segments")
      .set("Authorization", `Bearer ${marketerToken}`)
      .send({ name: segmentName, source: "parties", criteria: TEXTILES_CRITERIA })
      .expect(409);
  }, 120_000);

  it("edits the stored criteria in place, and the next read reflects them", async () => {
    const widened = {
      kind: "compare" as const,
      field: "name",
      operator: "starts_with" as const,
      value: "Segment probe",
    };

    await api()
      .patch(`/crm/segments/${segmentId}`)
      .set("Authorization", `Bearer ${marketerToken}`)
      .send({ description: null, criteria: widened })
      .expect(200);

    const response = await api()
      .get(`/crm/segments/${segmentId}/members?limit=100`)
      .set("Authorization", `Bearer ${marketerToken}`)
      .expect(200);

    /** Three Textiles plus one Logistics; the deleted one still does not count. */
    expect((response.body.data ?? response.body).total).toBe(4);
  }, 120_000);

  it("deletes it, and stops answering for it", async () => {
    await api()
      .delete(`/crm/segments/${segmentId}`)
      .set("Authorization", `Bearer ${marketerToken}`)
      .expect(200);

    await api()
      .get(`/crm/segments/${segmentId}`)
      .set("Authorization", `Bearer ${marketerToken}`)
      .expect(404);

    /**
     * 404 and not 403 on the evaluation path too. A 403 on an id that is not
     * yours confirms the record exists and turns a probe into an existence
     * oracle, so a missing segment and another organisation's segment have to
     * be indistinguishable.
     */
    await api()
      .get(`/crm/segments/${segmentId}/members?limit=10`)
      .set("Authorization", `Bearer ${marketerToken}`)
      .expect(404);
  }, 120_000);
});
