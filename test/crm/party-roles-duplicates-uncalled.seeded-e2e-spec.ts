import { randomUUID } from "node:crypto";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import {
  businessParties,
  partyDuplicateCandidates,
  partyIdentifiers,
  partyRoles,
} from "src/db/schema/party";
import {
  SEEDED_HARNESS,
  createSeededE2eApp,
  signSeededToken,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";

/**
 * CRM-UNCALLED-ROUTE-COVERAGE. The six `party` routes no screen calls.
 *
 * Second on blast radius after consent, and for a related reason: these routes
 * decide what a customer record *is* and which records are the same customer.
 *
 * A role is not decoration. `party_roles` is what separates a customer from a
 * vendor from a prospect, and other modules read it to decide whether a party
 * may appear on a sales document or a purchase one. `DELETE
 * /party/parties/:partyId/roles/:role` is a hard delete of that row — not a
 * soft one, despite the column being called `removed_at` and the add path
 * clearing it — so a wrong answer here silently reclassifies a business.
 *
 * The duplicate routes feed the merge machinery, and a merge fuses two
 * customers' histories. `POST /party/merges` and its revert already had a
 * behavioural spec; the three routes that decide *what reaches* that queue —
 * detect, list, dismiss — had only an authorisation table. A detector that
 * queued nothing, or a dismiss that dismissed somebody else's candidate, would
 * have passed it.
 *
 * Two of the tests below are failure cases rather than happy paths, because the
 * failure path is where an unexercised route rots first. `addRole` takes a bare
 * `@Body() body: { role: string }` with no schema between the wire and the
 * insert, which is the shape that turns a missing field into a 500.
 *
 * Run with:
 *   DATABASE_URL=postgres://owner@host/db \
 *   APP_DATABASE_URL=postgres://streamline_app@host/db \
 *   node --max-old-space-size=12288 ./node_modules/jest/bin/jest.js \
 *     --config ./jest-e2e-seeded.json --forceExit --runInBand \
 *     --testPathPattern=party-roles-duplicates-uncalled
 */

/** Everything the six routes gate on, split the way the controller splits it. */
const STEWARD_KEYS = [
  "party:parties:view",
  "party:roles:manage",
  "party:merges:manage",
  "party:duplicates:view",
] as const;

/**
 * May look at a party, may not reclassify one.
 *
 * `fixture.grantPermissions` only ever adds, so a narrower actor has to be
 * seeded as its own member rather than made by taking keys away from the first.
 */
const ONLOOKER_KEYS = ["party:parties:view", "party:duplicates:view"] as const;

/** A shared telephone line, written two different ways by two different records. */
const SHARED_LINE = "9876543210";

describe(`${SEEDED_HARNESS} the party role and duplicate routes nothing calls`, () => {
  let seeded: SeededE2eApp;
  let fixture: SeededFixture;
  let neighbour: SeededFixture;

  let stewardToken = "";
  let onlookerToken = "";

  let partyId = "";
  /** The other half of the duplicate pair, in our org. */
  let twinPartyId = "";
  /** A real party in another tenant — the id every cross-tenant probe uses. */
  let neighbourPartyId = "";
  let candidateId = "";

  const http = () => request(seeded.app.getHttpServer());

  const roleRows = (orgId: string, forPartyId: string) =>
    seeded.seedDb
      .select()
      .from(partyRoles)
      .where(and(eq(partyRoles.organizationId, orgId), eq(partyRoles.partyId, forPartyId)));

  async function seedParty(
    orgId: string,
    name: string,
    identifier?: { kind: string; value: string },
  ): Promise<string> {
    const id = randomUUID();
    await seeded.seedDb.insert(businessParties).values({
      partyId: id,
      organizationId: orgId,
      name,
    });
    if (identifier)
      await seeded.seedDb.insert(partyIdentifiers).values({
        organizationId: orgId,
        partyId: id,
        kind: identifier.kind,
        value: identifier.value,
        /**
         * The only column ever matched on. Set explicitly rather than through
         * `claimIdentifiers` so the pair below is a deliberate collision: the
         * unique index is on (org, kind, normalised_value), so two parties may
         * share a value only across kinds — which is exactly the real-world
         * case the detector exists for, one line recorded as a phone number on
         * one record and as a WhatsApp number on the other.
         */
        normalisedValue: SHARED_LINE,
      });
    return id;
  }

  beforeAll(async () => {
    seeded = await createSeededE2eApp();

    fixture = await seedOrg(seeded.seedDb)
      .addMember("steward", { permissionKeys: [...STEWARD_KEYS] })
      .addMember("onlooker", { permissionKeys: [...ONLOOKER_KEYS] })
      .build();

    neighbour = await seedOrg(seeded.seedDb)
      .addMember("steward", { permissionKeys: [...STEWARD_KEYS] })
      .build();

    stewardToken = await signSeededToken(seeded, fixture.members["steward"]!.userId, fixture.orgId);
    onlookerToken = await signSeededToken(seeded, fixture.members["onlooker"]!.userId, fixture.orgId);

    /**
     * One business, recorded twice, with the same name and one telephone line
     * filed under two kinds. That scores 0.65 — a shared phone group plus an
     * exact name — which is over the review threshold and under the auto-merge
     * one, so the pair lands in the queue rather than being fused unasked.
     * A pair that auto-merged would leave this file with nothing to list.
     */
    partyId = await seedParty(fixture.orgId, "Kadambari Textiles", {
      kind: "phone",
      value: `+91 ${SHARED_LINE}`,
    });
    twinPartyId = await seedParty(fixture.orgId, "Kadambari Textiles", {
      kind: "whatsapp",
      value: SHARED_LINE,
    });
    neighbourPartyId = await seedParty(neighbour.orgId, "Neighbour Holdings");
  }, 240_000);

  afterAll(async () => {
    for (const org of [fixture, neighbour]) {
      if (!org) continue;
      await seeded.seedDb
        .delete(partyDuplicateCandidates)
        .where(eq(partyDuplicateCandidates.organizationId, org.orgId));
      await seeded.seedDb
        .delete(partyIdentifiers)
        .where(eq(partyIdentifiers.organizationId, org.orgId));
      await seeded.seedDb.delete(partyRoles).where(eq(partyRoles.organizationId, org.orgId));
      await seeded.seedDb
        .delete(businessParties)
        .where(eq(businessParties.organizationId, org.orgId));
      await org.teardown();
    }
    await seeded?.close();
  }, 60_000);

  it("gives a party a role, and hands back the whole set", async () => {
    const response = await http()
      .post(`/party/parties/${partyId}/roles`)
      .set("Authorization", `Bearer ${stewardToken}`)
      .set("Idempotency-Key", `role-add-${partyId}`)
      .send({ role: "CUSTOMER" })
      .expect(201);

    const body = response.body.data ?? response.body;
    /** The set, not the one added — the caller renders the badges from this. */
    expect(body.roles).toEqual(["CUSTOMER"]);

    const rows = await roleRows(fixture.orgId, partyId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.role).toBe("CUSTOMER");
    expect(rows[0]!.removedAt).toBeNull();
    /** §6: the assigner is the token's subject, never a body field. */
    expect(rows[0]!.assignedBy).toBe(fixture.members["steward"]!.userId);
  }, 120_000);

  it("replays the same key without adding a second grant", async () => {
    /**
     * `@Idempotent("party.role.add")` stores the first response against the key
     * and replays it. Worth asserting on this route specifically because
     * `addRole` is *also* idempotent in the database — it upserts — so a broken
     * interceptor would be invisible in the row count. The evidence that the
     * replay happened rather than the handler running twice is the body coming
     * back identical while the second role added below is absent from it.
     */
    const replay = await http()
      .post(`/party/parties/${partyId}/roles`)
      .set("Authorization", `Bearer ${stewardToken}`)
      .set("Idempotency-Key", `role-add-${partyId}`)
      .send({ role: "CUSTOMER" })
      .expect(201);

    expect((replay.body.data ?? replay.body).roles).toEqual(["CUSTOMER"]);
    expect(await roleRows(fixture.orgId, partyId)).toHaveLength(1);

    /** A different key is a different operation, and does run. */
    const second = await http()
      .post(`/party/parties/${partyId}/roles`)
      .set("Authorization", `Bearer ${stewardToken}`)
      .set("Idempotency-Key", `role-add-vendor-${partyId}`)
      .send({ role: "VENDOR" })
      .expect(201);

    expect((second.body.data ?? second.body).roles.sort()).toEqual(["CUSTOMER", "VENDOR"]);
  }, 120_000);

  it("requires the idempotency key it declares", async () => {
    /**
     * A 400 that reads like body validation but is not. Asserted because a
     * caller integrating against this route sends a well-formed body, gets
     * "Idempotency-Key header is required", and has no way to tell from the
     * OpenAPI document that the header was mandatory.
     */
    await http()
      .post(`/party/parties/${partyId}/roles`)
      .set("Authorization", `Bearer ${stewardToken}`)
      .send({ role: "PARTNER" })
      .expect(400);

    expect(await roleRows(fixture.orgId, partyId)).toHaveLength(2);
  }, 120_000);

  it("rejects a request that names no role, rather than failing on the insert", async () => {
    /**
     * The failure case this file was written to find.
     *
     * `addRole` is declared `@Body() body: { role: string }` with no
     * `ZodValidationPipe`, so the TypeScript type is a claim about the wire that
     * nothing enforces. An omitted `role` reaches Drizzle as `undefined` and the
     * NOT NULL constraint on `party_roles.role` decides the status code — which
     * is a 500 telling an integrator the server is broken, when what happened is
     * that they left out a field.
     */
    await http()
      .post(`/party/parties/${partyId}/roles`)
      .set("Authorization", `Bearer ${stewardToken}`)
      .set("Idempotency-Key", `role-add-empty-${partyId}`)
      .send({})
      .expect(400);

    expect(await roleRows(fixture.orgId, partyId)).toHaveLength(2);
  }, 120_000);

  it("lists the roles, and refuses the write to someone who may only look", async () => {
    const response = await http()
      .get(`/party/parties/${partyId}/roles`)
      .set("Authorization", `Bearer ${onlookerToken}`)
      .expect(200);

    expect((response.body.data ?? response.body).roles.sort()).toEqual([
      "CUSTOMER",
      "VENDOR",
    ]);

    /** `party:parties:view` reads a party; reclassifying it needs `party:roles:manage`. */
    await http()
      .post(`/party/parties/${partyId}/roles`)
      .set("Authorization", `Bearer ${onlookerToken}`)
      .set("Idempotency-Key", `role-add-denied-${partyId}`)
      .send({ role: "PARTNER" })
      .expect(403);

    await http()
      .delete(`/party/parties/${partyId}/roles/CUSTOMER`)
      .set("Authorization", `Bearer ${onlookerToken}`)
      .expect(403);

    expect(await roleRows(fixture.orgId, partyId)).toHaveLength(2);
  }, 120_000);

  it("takes a role away, and takes the row with it", async () => {
    const response = await http()
      .delete(`/party/parties/${partyId}/roles/VENDOR`)
      .set("Authorization", `Bearer ${stewardToken}`)
      .expect(200);

    expect((response.body.data ?? response.body).roles).toEqual(["CUSTOMER"]);

    /**
     * A hard delete, despite `removed_at` existing on the table and the add
     * path clearing it. Asserted rather than assumed because the two halves
     * disagree about the model: a reader looking at the schema would expect a
     * tombstone here and find none, and any future audit built on `removed_at`
     * would silently have nothing to read.
     */
    const rows = await roleRows(fixture.orgId, partyId);
    expect(rows).toHaveLength(1);
    expect(rows.map((row) => row.role)).toEqual(["CUSTOMER"]);
  }, 120_000);

  it("reads another tenant's party as absent, not as forbidden", async () => {
    /**
     * 404, never 403.
     *
     * A 403 confirms the record exists, which turns any id into an existence
     * oracle over a competitor's customer list. `requireParty` scopes by
     * organisation and raises NotFound, so a real id in another tenant has to
     * be indistinguishable from an id that was never issued.
     */
    const madeUp = randomUUID();

    for (const probe of [neighbourPartyId, madeUp]) {
      await http()
        .get(`/party/parties/${probe}/roles`)
        .set("Authorization", `Bearer ${stewardToken}`)
        .expect(200)
        .expect((res) => {
          /** A list read scopes rather than refusing — empty, and empty for both. */
          expect((res.body.data ?? res.body).roles).toEqual([]);
        });

      await http()
        .post(`/party/parties/${probe}/roles`)
        .set("Authorization", `Bearer ${stewardToken}`)
        .set("Idempotency-Key", `role-cross-${probe}`)
        .send({ role: "CUSTOMER" })
        .expect(404);

      await http()
        .delete(`/party/parties/${probe}/roles/CUSTOMER`)
        .set("Authorization", `Bearer ${stewardToken}`)
        .expect(404);

      await http()
        .post(`/party/parties/${probe}/detect-duplicates`)
        .set("Authorization", `Bearer ${stewardToken}`)
        .set("Idempotency-Key", `detect-cross-${probe}`)
        .send({})
        .expect(404);
    }

    /** And nothing landed on the neighbour's record. */
    expect(await roleRows(neighbour.orgId, neighbourPartyId)).toHaveLength(0);
  }, 120_000);

  it("finds the twin record and queues it for a human", async () => {
    const response = await http()
      .post(`/party/parties/${partyId}/detect-duplicates`)
      .set("Authorization", `Bearer ${stewardToken}`)
      .set("Idempotency-Key", `detect-${partyId}`)
      .send({})
      .expect(201);

    const result = response.body.data ?? response.body;
    /**
     * Queued, not merged. The pair shares a telephone line and a name, which is
     * 0.65 — over the review threshold and well under the auto-merge one. The
     * asymmetry is deliberate: a missed duplicate leaves two rows a human can
     * fuse later, a false merge fuses two customers' histories.
     */
    expect(result.autoMerged).toEqual([]);
    expect(result.queued).toHaveLength(1);
    expect(result.queued[0].otherPartyId).toBe(twinPartyId);
    expect(result.queued[0].score).toBeGreaterThanOrEqual(0.45);
    expect(result.queued[0].score).toBeLessThan(0.85);

    const [row] = await seeded.seedDb
      .select()
      .from(partyDuplicateCandidates)
      .where(eq(partyDuplicateCandidates.organizationId, fixture.orgId));
    expect(row).toBeDefined();
    expect(row!.status).toBe("PENDING");
    /**
     * The pair is stored ordered, so detecting from either side finds the same
     * row rather than queueing the same two records twice.
     */
    expect([row!.lowPartyId, row!.highPartyId].sort()).toEqual(
      [partyId, twinPartyId].sort(),
    );
    expect(row!.signals).toEqual(expect.arrayContaining(["phone"]));
    candidateId = row!.candidateId;
  }, 120_000);

  it("detecting from the other side updates the same candidate", async () => {
    await http()
      .post(`/party/parties/${twinPartyId}/detect-duplicates`)
      .set("Authorization", `Bearer ${stewardToken}`)
      .set("Idempotency-Key", `detect-${twinPartyId}`)
      .send({})
      .expect(201);

    const rows = await seeded.seedDb
      .select()
      .from(partyDuplicateCandidates)
      .where(eq(partyDuplicateCandidates.organizationId, fixture.orgId));
    /** One pair, one row — the ordered key is what makes that true. */
    expect(rows).toHaveLength(1);
    expect(rows[0]!.candidateId).toBe(candidateId);
  }, 120_000);

  it("lists the pending queue, and only its own tenant's", async () => {
    const response = await http()
      .get("/party/duplicates")
      .set("Authorization", `Bearer ${stewardToken}`)
      .expect(200);

    /**
     * The handler returns `{ data: [...] }` itself. `ResponseTransformInterceptor`
     * is registered in `main.ts` and not in this harness, so nothing wraps it a
     * second time here and `body.data` is the list.
     */
    const list = response.body.data;
    expect(list).toHaveLength(1);
    expect(list[0].candidateId).toBe(candidateId);

    const theirs = await http()
      .get("/party/duplicates")
      .set(
        "Authorization",
        `Bearer ${await signSeededToken(seeded, 
          neighbour.members["steward"]!.userId,
          neighbour.orgId,
        )}`,
      )
      .expect(200);
    expect(theirs.body.data).toEqual([]);
  }, 120_000);

  it("dismisses the candidate, and drops it out of the pending list", async () => {
    await http()
      .delete(`/party/duplicates/${candidateId}`)
      .set("Authorization", `Bearer ${stewardToken}`)
      .expect(200);

    const [row] = await seeded.seedDb
      .select()
      .from(partyDuplicateCandidates)
      .where(eq(partyDuplicateCandidates.candidateId, candidateId));

    expect(row!.status).toBe("DISMISSED");
    expect(row!.resolvedAt).not.toBeNull();
    /** Who decided these were different businesses is the point of keeping the row. */
    expect(row!.resolvedByUserId).toBe(fixture.members["steward"]!.userId);

    const after = await http()
      .get("/party/duplicates")
      .set("Authorization", `Bearer ${stewardToken}`)
      .expect(200);
    expect(after.body.data).toEqual([]);
  }, 120_000);

  it("will not dismiss a candidate that is not this tenant's", async () => {
    /**
     * `dismissCandidate` scopes the UPDATE by organisation and raises NotFound
     * when nothing was updated. Without the org predicate the dismiss would
     * succeed silently against another tenant's queue, and the only evidence
     * would be a duplicate pair quietly disappearing from somebody else's
     * review list.
     */
    const theirCandidateId = randomUUID();
    await seeded.seedDb.insert(partyDuplicateCandidates).values({
      candidateId: theirCandidateId,
      organizationId: neighbour.orgId,
      lowPartyId: neighbourPartyId,
      highPartyId: randomUUID(),
      score: 0.6,
      signals: ["phone"],
      blockers: [],
    });

    await http()
      .delete(`/party/duplicates/${theirCandidateId}`)
      .set("Authorization", `Bearer ${stewardToken}`)
      .expect(404);

    const [row] = await seeded.seedDb
      .select()
      .from(partyDuplicateCandidates)
      .where(eq(partyDuplicateCandidates.candidateId, theirCandidateId));
    expect(row!.status).toBe("PENDING");
    expect(row!.resolvedAt).toBeNull();
  }, 120_000);
});
