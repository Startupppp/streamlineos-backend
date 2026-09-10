import { randomUUID } from "node:crypto";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import {
  businessParties,
  contactPartyMap,
  partyDuplicateCandidates,
  partyIdentifiers,
  partyMerges,
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
 * Merging two customer records, and taking it back.
 *
 * `POST /party/merges` and its revert had only a mocked unit spec
 * (`party-merge.spec.ts`), and the contact-grain merge that the UI actually
 * called had no e2e at all. That mattered because the two disagreed about what
 * a merge is: `/contacts/merge` soft-deleted a party without moving its
 * identifiers, unioning its roles, re-pointing its employees or writing a
 * `party_merges` row — so it could not be undone, and the address the losing
 * record owned went on resolving to a deleted party. This file is the
 * behavioural evidence for the mechanism that replaced it.
 *
 * Every assertion below is a thing the retired mechanism got wrong, plus the two
 * the surviving one had no HTTP surface for: the caller's choice of survivor,
 * and reading the ledger back after the toast is gone.
 *
 * Run with:
 *   DATABASE_URL=postgres://owner@host/db \
 *   APP_DATABASE_URL=postgres://streamline_app@host/db \
 *   node --max-old-space-size=12288 ./node_modules/jest/bin/jest.js \
 *     --config ./jest-e2e-seeded.json --forceExit --runInBand \
 *     --testPathPattern=party-merge-revert
 */

const STEWARD_KEYS = [
  "party:parties:view",
  "party:duplicates:view",
  "party:merges:manage",
  "crm:contacts:view",
] as const;

/** May see the queue, may not act on it. */
const ONLOOKER_KEYS = ["party:parties:view", "party:duplicates:view"] as const;

const SHARED_ADDRESS = "ops@kadambari.example";

describe(`${SEEDED_HARNESS} merging two customer records, and reverting it`, () => {
  let seeded: SeededE2eApp;
  let fixture: SeededFixture;
  let neighbour: SeededFixture;

  let stewardToken = "";
  let onlookerToken = "";

  /** The record the reviewer keeps. Created second, so it is the YOUNGER one. */
  let survivorPartyId = "";
  /** The record merged away. Older, and therefore what `chooseSurvivor` prefers. */
  let loserPartyId = "";
  let survivorContactId = 0;
  let loserContactId = 0;
  let neighbourPartyId = "";

  let partyMergeId = "";

  const http = () => request(seeded.app.getHttpServer());

  const partyRow = (partyId: string) =>
    seeded.seedDb
      .select()
      .from(businessParties)
      .where(
        and(
          eq(businessParties.organizationId, fixture.orgId),
          eq(businessParties.partyId, partyId),
        ),
      )
      .then((rows) => rows[0]);

  const identifierOwners = () =>
    seeded.seedDb
      .select({ partyId: partyIdentifiers.partyId, value: partyIdentifiers.normalisedValue })
      .from(partyIdentifiers)
      .where(eq(partyIdentifiers.organizationId, fixture.orgId));

  const rolesOf = (partyId: string) =>
    seeded.seedDb
      .select({ role: partyRoles.role })
      .from(partyRoles)
      .where(
        and(eq(partyRoles.organizationId, fixture.orgId), eq(partyRoles.partyId, partyId)),
      )
      .then((rows) => rows.map((row) => row.role).sort());

  const mapRowsFor = (partyId: string) =>
    seeded.seedDb
      .select({ contactId: contactPartyMap.contactId })
      .from(contactPartyMap)
      .where(
        and(
          eq(contactPartyMap.organizationId, fixture.orgId),
          eq(contactPartyMap.partyId, partyId),
        ),
      )
      .then((rows) => rows.map((row) => row.contactId).sort((a, b) => a - b));

  /**
   * A party plus the contact alias every CRM screen addresses it by.
   *
   * Written straight into `contact_party_map` rather than through the mirror
   * writer: the map row IS the contact since ticket 08, and minting one here
   * keeps the fixture honest about what a "contact" is on this branch.
   */
  async function seedContactParty(
    orgId: string,
    name: string,
    fields: { email?: string; phone?: string; role?: string; createdAt?: Date } = {},
  ): Promise<{ partyId: string; contactId: number }> {
    const partyId = randomUUID();
    await seeded.seedDb.insert(businessParties).values({
      partyId,
      organizationId: orgId,
      name,
      partyKind: "PERSON",
      email: fields.email ?? null,
      phone: fields.phone ?? null,
      ...(fields.createdAt ? { createdAt: fields.createdAt } : {}),
    });

    if (fields.email)
      await seeded.seedDb.insert(partyIdentifiers).values({
        organizationId: orgId,
        partyId,
        kind: "email",
        value: fields.email,
        normalisedValue: fields.email.toLowerCase(),
      });

    if (fields.role)
      await seeded.seedDb
        .insert(partyRoles)
        .values({ organizationId: orgId, partyId, role: fields.role });

    const [map] = await seeded.seedDb
      .insert(contactPartyMap)
      .values({ organizationId: orgId, partyId, linkedBy: "seed" })
      .returning({ contactId: contactPartyMap.contactId });

    return { partyId, contactId: map!.contactId };
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

    stewardToken = await signSeededToken(fixture.members["steward"]!.userId, fixture.orgId);
    onlookerToken = await signSeededToken(fixture.members["onlooker"]!.userId, fixture.orgId);

    /*
     * The loser is deliberately the OLDER record and the one holding the shared
     * address. `chooseSurvivor` keeps the older party when nobody says
     * otherwise, so "the reviewer's choice was honoured" and "the default
     * happened to agree" are distinguishable here — which they would not be if
     * the kept record were also the older one.
     */
    const loser = await seedContactParty(fixture.orgId, "Kadambari Textiles (old)", {
      email: SHARED_ADDRESS,
      role: "VENDOR",
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
    });
    loserPartyId = loser.partyId;
    loserContactId = loser.contactId;

    const survivor = await seedContactParty(fixture.orgId, "Kadambari Textiles", {
      phone: "+91 9876543210",
      role: "CUSTOMER",
      createdAt: new Date("2025-06-01T00:00:00.000Z"),
    });
    survivorPartyId = survivor.partyId;
    survivorContactId = survivor.contactId;

    const foreign = await seedContactParty(neighbour.orgId, "Neighbour Holdings");
    neighbourPartyId = foreign.partyId;
  }, 240_000);

  afterAll(async () => {
    for (const org of [fixture, neighbour]) {
      if (!org) continue;
      await seeded.seedDb
        .delete(partyMerges)
        .where(eq(partyMerges.organizationId, org.orgId));
      await seeded.seedDb
        .delete(partyDuplicateCandidates)
        .where(eq(partyDuplicateCandidates.organizationId, org.orgId));
      await seeded.seedDb
        .delete(contactPartyMap)
        .where(eq(contactPartyMap.organizationId, org.orgId));
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

  it("refuses the merge to someone who may only look at the queue", async () => {
    await http()
      .post("/party/merges")
      .set("Authorization", `Bearer ${onlookerToken}`)
      .set("Idempotency-Key", `merge-denied-${survivorPartyId}`)
      .send({ leftPartyId: survivorPartyId, rightPartyId: loserPartyId })
      .expect(403);

    expect((await partyRow(loserPartyId))!.deletedAt).toBeNull();
  }, 120_000);

  it("reads a party in another tenant as absent, not as forbidden", async () => {
    /**
     * 404 rather than 403, or the response confirms a competitor's record
     * exists. Both arrangements are probed: the foreign id on either side.
     */
    for (const body of [
      { leftPartyId: survivorPartyId, rightPartyId: neighbourPartyId },
      { leftPartyId: neighbourPartyId, rightPartyId: survivorPartyId },
    ])
      await http()
        .post("/party/merges")
        .set("Authorization", `Bearer ${stewardToken}`)
        .set("Idempotency-Key", `merge-cross-${body.rightPartyId}-${body.leftPartyId}`)
        .send(body)
        .expect(404);

    const [row] = await seeded.seedDb
      .select()
      .from(businessParties)
      .where(
        and(
          eq(businessParties.organizationId, neighbour.orgId),
          eq(businessParties.partyId, neighbourPartyId),
        ),
      );
    expect(row!.deletedAt).toBeNull();
  }, 120_000);

  it("will not accept a survivor that names neither record", async () => {
    /**
     * A 400 rather than a silent fallback to `chooseSurvivor`. Asserted because
     * ignoring an unrecognised value is how a client bug becomes a merge that
     * kept the wrong record and reported success.
     */
    await http()
      .post("/party/merges")
      .set("Authorization", `Bearer ${stewardToken}`)
      .set("Idempotency-Key", `merge-bad-survivor-${survivorPartyId}`)
      .send({
        leftPartyId: survivorPartyId,
        rightPartyId: loserPartyId,
        preferSurvivorPartyId: randomUUID(),
      })
      .expect(400);

    expect((await partyRow(loserPartyId))!.deletedAt).toBeNull();
  }, 120_000);

  it("keeps the record the reviewer picked, not the older one", async () => {
    const response = await http()
      .post("/party/merges")
      .set("Authorization", `Bearer ${stewardToken}`)
      .set("Idempotency-Key", `merge-${survivorPartyId}`)
      .send({
        leftPartyId: survivorPartyId,
        rightPartyId: loserPartyId,
        preferSurvivorPartyId: survivorPartyId,
      })
      .expect(201);

    const body = response.body.data ?? response.body;
    /**
     * The heart of it. `chooseSurvivor` prefers the older party, which is the
     * loser here — so this passing means the caller's choice reached the
     * service. Before `preferSurvivorPartyId` existed on the schema the route
     * could not carry it, and this merge would have kept "Kadambari Textiles
     * (old)" while the reviewer was looking at the other card.
     */
    expect(body.survivorPartyId).toBe(survivorPartyId);
    expect(body.mergedPartyId).toBe(loserPartyId);
    expect(body.partyMergeId).toEqual(expect.any(String));
    partyMergeId = body.partyMergeId;

    expect((await partyRow(survivorPartyId))!.deletedAt).toBeNull();
    expect((await partyRow(loserPartyId))!.deletedAt).not.toBeNull();
  }, 120_000);

  it("hands the loser's identifiers to the survivor rather than leaving them on a deleted record", async () => {
    /**
     * The defect that made the retired contact merge worse than doing nothing.
     *
     * `/contacts/merge` never moved `party_identifiers`, and `claimIdentifiers`
     * is `ON CONFLICT DO NOTHING`, so the survivor's inherited address silently
     * failed to claim while the soft-deleted loser kept it. The next message to
     * that address hit `resolvePartyByIdentifier`, which RELEASES a claim held
     * by a deleted party — creating a third record. The merge manufactured the
     * duplicate it was called to remove.
     */
    const owners = await identifierOwners();
    const shared = owners.find((row) => row.value === SHARED_ADDRESS);

    expect(shared).toBeDefined();
    expect(shared!.partyId).toBe(survivorPartyId);
    expect(owners.every((row) => row.partyId !== loserPartyId)).toBe(true);
  }, 120_000);

  it("unions the roles rather than destroying the loser's", async () => {
    /**
     * The loser was a VENDOR and the survivor a CUSTOMER. `party_roles` is what
     * other modules read to decide whether a party may appear on a purchase
     * document, so dropping VENDOR here silently reclassifies a business — and
     * the contact merge dropped it, because it never looked at the table.
     */
    expect(await rolesOf(survivorPartyId)).toEqual(["CUSTOMER", "VENDOR"]);
  }, 120_000);

  it("leaves the loser's contact id resolving, and off the list", async () => {
    /**
     * Both halves matter and they pull in opposite directions.
     *
     * `repointLegacyIds` moves the loser's `contact_party_map` row onto the
     * survivor so a bookmark or a foreign key holding the old number still
     * lands on a live record — so the point read must answer 200.
     *
     * But `contact_party_map.party_id` is not unique, and every contact LIST
     * read starts from that table, so the survivor would otherwise appear once
     * per alias: the merged-away duplicate back on the screen the merge was
     * called to clean up. `canonicalContactOnly` applies the lowest-id-wins rule
     * the rest of the legacy-id resolution already uses.
     */
    expect(await mapRowsFor(survivorPartyId)).toEqual(
      [survivorContactId, loserContactId].sort((a, b) => a - b),
    );

    for (const contactId of [survivorContactId, loserContactId])
      await http()
        .get(`/contacts/${contactId}`)
        .set("Authorization", `Bearer ${stewardToken}`)
        .expect(200);

    const list = await http()
      .get("/contacts?limit=100")
      .set("Authorization", `Bearer ${stewardToken}`)
      .expect(200);

    const items = (list.body.data ?? list.body).items as { id: number; partyId: string }[];
    const forSurvivor = items.filter((item) => item.partyId === survivorPartyId);
    expect(forSurvivor).toHaveLength(1);
    /** The canonical alias is the lower id, which is the loser's — it was minted first. */
    expect(forSurvivor[0]!.id).toBe(Math.min(survivorContactId, loserContactId));
  }, 120_000);

  it("lists the merge afterwards, so the revert outlives the toast", async () => {
    /**
     * The reason this route exists. `party_merges` held everything a revert
     * needs and nothing read it, so the only moment a merge could be undone was
     * the moment it happened. A destructive action whose reversal expires with
     * the notification announcing it is not reversible in any sense the user
     * experiences.
     */
    const response = await http()
      .get("/party/merges")
      .set("Authorization", `Bearer ${stewardToken}`)
      .expect(200);

    const body = response.body.data ?? response.body;
    const row = (body.data as { partyMergeId: string }[]).find(
      (entry) => entry.partyMergeId === partyMergeId,
    ) as
      | { survivorName: string; mergedName: string; decidedBy: string; revertedAt: string | null }
      | undefined;

    expect(row).toBeDefined();
    /** Names, never the two party ids on their own — the reader has to know which records. */
    expect(row!.survivorName).toBe("Kadambari Textiles");
    /**
     * From the snapshot, not from a join: the loser is soft-deleted, so a live
     * read of it is filtered out everywhere else in this module.
     */
    expect(row!.mergedName).toBe("Kadambari Textiles (old)");
    expect(row!.decidedBy).toBe("USER");
    expect(row!.revertedAt).toBeNull();
  }, 120_000);

  it("refuses the revert to someone who may only look", async () => {
    await http()
      .post(`/party/merges/${partyMergeId}/revert`)
      .set("Authorization", `Bearer ${onlookerToken}`)
      .set("Idempotency-Key", `revert-denied-${partyMergeId}`)
      .send({})
      .expect(403);

    expect((await partyRow(loserPartyId))!.deletedAt).not.toBeNull();
  }, 120_000);

  it("puts both records back exactly as they were", async () => {
    const response = await http()
      .post(`/party/merges/${partyMergeId}/revert`)
      .set("Authorization", `Bearer ${stewardToken}`)
      .set("Idempotency-Key", `revert-${partyMergeId}`)
      .send({})
      .expect(201);

    const body = response.body.data ?? response.body;
    expect(body.restoredPartyId).toBe(loserPartyId);

    const restored = await partyRow(loserPartyId);
    expect(restored!.deletedAt).toBeNull();
    expect(restored!.name).toBe("Kadambari Textiles (old)");

    /** The address goes back to the record it came from, not to whoever holds it now. */
    const owners = await identifierOwners();
    expect(owners.find((row) => row.value === SHARED_ADDRESS)!.partyId).toBe(loserPartyId);

    /** Only the role the merge ADDED is taken away; the survivor's own is its own. */
    expect(await rolesOf(survivorPartyId)).toEqual(["CUSTOMER"]);
    expect(await rolesOf(loserPartyId)).toEqual(["VENDOR"]);

    /** And the contact alias goes home, so both people are on the list again. */
    expect(await mapRowsFor(survivorPartyId)).toEqual([survivorContactId]);
    expect(await mapRowsFor(loserPartyId)).toEqual([loserContactId]);
  }, 120_000);

  it("will not revert the same merge twice", async () => {
    /**
     * `revert` selects on `reverted_at IS NULL`, so a second attempt finds
     * nothing. 404 rather than a second restore, which would re-run every
     * re-point against records that have already moved back.
     */
    await http()
      .post(`/party/merges/${partyMergeId}/revert`)
      .set("Authorization", `Bearer ${stewardToken}`)
      .set("Idempotency-Key", `revert-again-${partyMergeId}`)
      .send({})
      .expect(404);

    const reverted = await http()
      .get("/party/merges?includeReverted=true")
      .set("Authorization", `Bearer ${stewardToken}`)
      .expect(200);

    const rows = ((reverted.body.data ?? reverted.body).data ?? []) as {
      partyMergeId: string;
      revertedAt: string | null;
    }[];
    expect(rows.find((row) => row.partyMergeId === partyMergeId)!.revertedAt).not.toBeNull();

    /** And it is gone from the default list, which offers only what can still be undone. */
    const pending = await http()
      .get("/party/merges")
      .set("Authorization", `Bearer ${stewardToken}`)
      .expect(200);
    const pendingRows = ((pending.body.data ?? pending.body).data ?? []) as {
      partyMergeId: string;
    }[];
    expect(pendingRows.some((row) => row.partyMergeId === partyMergeId)).toBe(false);
  }, 120_000);

  it("names both records in the duplicate queue, and remembers a dismissal", async () => {
    /**
     * The other half of what the retired mechanism could not do.
     * `/contacts/duplicates` recomputed pairs on every read, so a dismissal had
     * nowhere to live and the same wrong pair came back forever. This queue is a
     * row, and `DELETE` resolves it.
     *
     * The projection is asserted alongside because the candidate row holds two
     * party ids and nothing else: returning it raw would make the reviewer
     * decide whether two businesses are the same from a pair of UUIDs, and put a
     * party id on screen (frontend §5).
     */
    await http()
      .post(`/party/parties/${survivorPartyId}/detect-duplicates`)
      .set("Authorization", `Bearer ${stewardToken}`)
      .set("Idempotency-Key", `detect-after-revert-${survivorPartyId}`)
      .send({})
      .expect(201);

    const [candidate] = await seeded.seedDb
      .select()
      .from(partyDuplicateCandidates)
      .where(eq(partyDuplicateCandidates.organizationId, fixture.orgId));

    /*
     * The pair shares neither an address nor a line any more — the revert put
     * each identifier back on its own record — so detection may legitimately
     * find nothing. Queue one directly in that case: what this test is about is
     * the queue's projection and the durability of a dismissal, not the
     * detector, which `party-roles-duplicates-uncalled` already covers.
     */
    const candidateId =
      candidate?.candidateId ??
      (
        await seeded.seedDb
          .insert(partyDuplicateCandidates)
          .values({
            organizationId: fixture.orgId,
            lowPartyId: [survivorPartyId, loserPartyId].sort()[0]!,
            highPartyId: [survivorPartyId, loserPartyId].sort()[1]!,
            score: 0.6,
            signals: ["name"],
            blockers: [],
          })
          .returning({ candidateId: partyDuplicateCandidates.candidateId })
      )[0]!.candidateId;

    const queue = await http()
      .get("/party/duplicates")
      .set("Authorization", `Bearer ${stewardToken}`)
      .expect(200);

    const body = queue.body.data ?? queue.body;
    const row = (body.data as { candidateId: string }[]).find(
      (entry) => entry.candidateId === candidateId,
    ) as
      | { left: { name: string; partyId: string }; right: { name: string } }
      | undefined;

    expect(row).toBeDefined();
    expect([row!.left.name, row!.right.name].sort()).toEqual([
      "Kadambari Textiles",
      "Kadambari Textiles (old)",
    ]);
    expect(body.pagination.total).toBeGreaterThanOrEqual(1);

    await http()
      .delete(`/party/duplicates/${candidateId}`)
      .set("Authorization", `Bearer ${stewardToken}`)
      .expect(200);

    /**
     * The point of a persisted queue: the dismissal survives the next read.
     * A recomputed list cannot remember this, which is why the same false
     * positive reappeared on every visit to the old screen.
     */
    const after = await http()
      .get("/party/duplicates")
      .set("Authorization", `Bearer ${stewardToken}`)
      .expect(200);
    const remaining = ((after.body.data ?? after.body).data ?? []) as {
      candidateId: string;
    }[];
    expect(remaining.some((entry) => entry.candidateId === candidateId)).toBe(false);

    const [stored] = await seeded.seedDb
      .select()
      .from(partyDuplicateCandidates)
      .where(eq(partyDuplicateCandidates.candidateId, candidateId));
    expect(stored!.status).toBe("DISMISSED");
    expect(stored!.resolvedByUserId).toBe(fixture.members["steward"]!.userId);
  }, 120_000);

  it("no longer serves the contact-grain merge at all", async () => {
    /**
     * "Rewrites replace, never parallel." The contact merge was a second name
     * for this mechanism that performed a fraction of it, and leaving it
     * reachable would leave the irreversible path one URL away from the
     * reversible one.
     */
    await http()
      .post("/contacts/merge")
      .set("Authorization", `Bearer ${stewardToken}`)
      .set("Idempotency-Key", `retired-merge-${survivorContactId}`)
      .send({ primaryId: survivorContactId, duplicateId: loserContactId })
      .expect(404);

    await http()
      .get("/contacts/duplicates")
      .set("Authorization", `Bearer ${stewardToken}`)
      /**
       * 400, not 404: `GET /contacts/:contactId/roles` still matches this path
       * with "duplicates" as the id, and `ParseIntPipe` rejects it. What matters
       * is that no duplicate list comes back.
       */
      .expect((res) => {
        expect([400, 404]).toContain(res.status);
        expect(res.body.data).toBeUndefined();
      });
  }, 120_000);
});
