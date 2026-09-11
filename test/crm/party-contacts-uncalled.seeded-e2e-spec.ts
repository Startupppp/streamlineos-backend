import { randomUUID } from "node:crypto";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { businessParties, partyContacts } from "src/db/schema/party";
import {
  SEEDED_HARNESS,
  createSeededE2eApp,
  signSeededToken,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";

/**
 * CRM-UNCALLED-ROUTE-COVERAGE. The four uncalled `party` contact routes.
 *
 * These are the people behind a company record — the names, addresses and
 * telephone numbers an organisation holds about identifiable individuals. They
 * mutate personal data, which puts them above every read in the ranking and
 * below only consent and the identity-merge machinery.
 *
 * Two properties here are worth asserting precisely because no caller exercises
 * them and no authorisation table can see them.
 *
 * The first is where a new contact is attached. `createContactSchema` requires
 * a `partyId` in the *body*, and the controller then writes
 * `{ ...body, partyId }` with the path's value last. So a body naming a
 * different party is silently overridden by the path — the safe direction, and
 * the one that has to stay that way, because the alternative lets a caller
 * hang a contact off a party they never named in a URL any gate could see.
 *
 * The second is what a delete does. `softDeleteContact` stamps `deleted_at`
 * and leaves the row, while `listContacts` filters it out. A reader who saw
 * only the list would conclude the record is gone; it is not, and under a
 * DPDP/GDPR erasure request the difference is the whole answer.
 *
 * Run with:
 *   DATABASE_URL=postgres://owner@host/db \
 *   APP_DATABASE_URL=postgres://streamline_app@host/db \
 *   node --max-old-space-size=12288 ./node_modules/jest/bin/jest.js \
 *     --config ./jest-e2e-seeded.json --forceExit --runInBand \
 *     --testPathPattern=party-contacts-uncalled
 */

const STEWARD_KEYS = [
  "party:parties:view",
  "party:contacts:view",
  "party:contacts:manage",
] as const;

/** May read the people, may not change them. */
const READER_KEYS = ["party:parties:view", "party:contacts:view"] as const;

describe(`${SEEDED_HARNESS} the party contact routes nothing calls`, () => {
  let seeded: SeededE2eApp;
  let fixture: SeededFixture;
  let neighbour: SeededFixture;

  let stewardToken = "";
  let readerToken = "";
  let neighbourToken = "";

  let partyId = "";
  let otherPartyId = "";
  let neighbourPartyId = "";
  let neighbourContactId = "";
  let contactId = "";

  const http = () => request(seeded.app.getHttpServer());

  const contactRow = (partyContactId: string) =>
    seeded.seedDb
      .select()
      .from(partyContacts)
      .where(eq(partyContacts.partyContactId, partyContactId))
      .then((rows) => rows[0]);

  const contactsOfParty = (orgId: string, forPartyId: string) =>
    seeded.seedDb
      .select()
      .from(partyContacts)
      .where(
        and(
          eq(partyContacts.organizationId, orgId),
          eq(partyContacts.partyId, forPartyId),
        ),
      );

  async function seedParty(orgId: string, name: string): Promise<string> {
    const id = randomUUID();
    await seeded.seedDb
      .insert(businessParties)
      .values({ partyId: id, organizationId: orgId, name });
    return id;
  }

  beforeAll(async () => {
    seeded = await createSeededE2eApp();

    fixture = await seedOrg(seeded.seedDb)
      .addMember("steward", { permissionKeys: [...STEWARD_KEYS] })
      .addMember("reader", { permissionKeys: [...READER_KEYS] })
      .build();

    neighbour = await seedOrg(seeded.seedDb)
      .addMember("steward", { permissionKeys: [...STEWARD_KEYS] })
      .build();

    stewardToken = await signSeededToken(seeded, fixture.members["steward"]!.userId, fixture.orgId);
    readerToken = await signSeededToken(seeded, fixture.members["reader"]!.userId, fixture.orgId);
    neighbourToken = await signSeededToken(seeded, 
      neighbour.members["steward"]!.userId,
      neighbour.orgId,
    );

    partyId = await seedParty(fixture.orgId, "Vaidehi Logistics");
    otherPartyId = await seedParty(fixture.orgId, "Unrelated Trading");
    neighbourPartyId = await seedParty(neighbour.orgId, "Neighbour Holdings");

    const [theirContact] = await seeded.seedDb
      .insert(partyContacts)
      .values({
        organizationId: neighbour.orgId,
        partyId: neighbourPartyId,
        firstName: "Someone",
        lastName: "Else",
        email: "someone@neighbour.invalid",
      })
      .returning({ partyContactId: partyContacts.partyContactId });
    neighbourContactId = theirContact!.partyContactId;
  }, 240_000);

  afterAll(async () => {
    for (const org of [fixture, neighbour]) {
      if (!org) continue;
      await seeded.seedDb
        .delete(partyContacts)
        .where(eq(partyContacts.organizationId, org.orgId));
      await seeded.seedDb
        .delete(businessParties)
        .where(eq(businessParties.organizationId, org.orgId));
      await org.teardown();
    }
    await seeded?.close();
  }, 60_000);

  it("creates a contact under the party the path names", async () => {
    const response = await http()
      .post(`/party/parties/${partyId}/contacts`)
      .set("Authorization", `Bearer ${stewardToken}`)
      .set("Idempotency-Key", `contact-create-${partyId}`)
      .send({
        partyId,
        firstName: "Vaidehi",
        lastName: "Rao",
        email: "vaidehi@logistics.invalid",
        phone: "+91 98200 11223",
        title: "Head of Operations",
      })
      .expect(201);

    const body = response.body.data ?? response.body;
    expect(typeof body.partyContactId).toBe("string");
    expect(body.partyId).toBe(partyId);
    expect(body.firstName).toBe("Vaidehi");
    /** Not the primary contact unless the caller says so; the column defaults false. */
    expect(body.isPrimary).toBe(false);
    expect(body.deletedAt).toBeNull();

    contactId = body.partyContactId;

    const row = await contactRow(contactId);
    expect(row!.organizationId).toBe(fixture.orgId);
    expect(row!.email).toBe("vaidehi@logistics.invalid");
    expect(row!.title).toBe("Head of Operations");
  }, 120_000);

  it("the path wins over a body that names a different party", async () => {
    /**
     * The controller writes `{ ...body, partyId }` — path last. Asserted
     * because the reverse order is a one-word edit that no type would catch and
     * no gate would see: the URL a permission check reads would name one party
     * while the row landed on another.
     */
    const response = await http()
      .post(`/party/parties/${partyId}/contacts`)
      .set("Authorization", `Bearer ${stewardToken}`)
      .set("Idempotency-Key", `contact-create-mismatch-${partyId}`)
      .send({ partyId: otherPartyId, firstName: "Path", lastName: "Wins" })
      .expect(201);

    expect((response.body.data ?? response.body).partyId).toBe(partyId);
    expect(await contactsOfParty(fixture.orgId, otherPartyId)).toHaveLength(0);
    expect(await contactsOfParty(fixture.orgId, partyId)).toHaveLength(2);
  }, 120_000);

  it("still demands a partyId in the body the path already carries", async () => {
    /**
     * A wart, asserted so it is a decision rather than an accident.
     *
     * `createContactSchema` requires `partyId` as a UUID even though the
     * controller discards whatever arrives there. An integrator who reads the
     * route — the party is in the path — sends a well-formed body and gets a
     * 400 about a field that has no effect on the result.
     */
    await http()
      .post(`/party/parties/${partyId}/contacts`)
      .set("Authorization", `Bearer ${stewardToken}`)
      .set("Idempotency-Key", `contact-create-nobody-${partyId}`)
      .send({ firstName: "No party id" })
      .expect(400);

    expect(await contactsOfParty(fixture.orgId, partyId)).toHaveLength(2);
  }, 120_000);

  it("lists the party's people, and refuses the write to a reader", async () => {
    const response = await http()
      .get(`/party/parties/${partyId}/contacts`)
      .set("Authorization", `Bearer ${readerToken}`)
      .expect(200);

    const rows = response.body.data ?? response.body;
    expect(rows).toHaveLength(2);
    expect(rows.map((row: { firstName: string }) => row.firstName).sort()).toEqual([
      "Path",
      "Vaidehi",
    ]);

    await http()
      .patch(`/party/contacts/${contactId}`)
      .set("Authorization", `Bearer ${readerToken}`)
      .set("Idempotency-Key", `contact-patch-denied-${contactId}`)
      .send({ firstName: "Tampered" })
      .expect(403);

    await http()
      .delete(`/party/contacts/${contactId}`)
      .set("Authorization", `Bearer ${readerToken}`)
      .set("Idempotency-Key", `contact-delete-denied-${contactId}`)
      .expect(403);
  }, 120_000);

  it("patches only the fields it names, and clears the ones set to null", async () => {
    const response = await http()
      .patch(`/party/contacts/${contactId}`)
      .set("Authorization", `Bearer ${stewardToken}`)
      .set("Idempotency-Key", `contact-patch-${contactId}`)
      .send({ title: null, isPrimary: true })
      .expect(200);

    const body = response.body.data ?? response.body;
    /**
     * `updateContact` builds the patch from `!== undefined`, so an explicit
     * null clears and an absent key is left alone. The two are one character
     * apart in a JSON body and mean opposite things, which is exactly why a
     * route with no caller needs this asserted rather than inferred.
     */
    expect(body.title).toBeNull();
    expect(body.isPrimary).toBe(true);
    expect(body.firstName).toBe("Vaidehi");
    expect(body.email).toBe("vaidehi@logistics.invalid");
    expect(body.phone).toBe("+91 98200 11223");
  }, 120_000);

  it("deletes softly: out of the list, still in the table", async () => {
    await http()
      .delete(`/party/contacts/${contactId}`)
      .set("Authorization", `Bearer ${stewardToken}`)
      .set("Idempotency-Key", `contact-delete-${contactId}`)
      .expect(204);

    const list = await http()
      .get(`/party/parties/${partyId}/contacts`)
      .set("Authorization", `Bearer ${stewardToken}`)
      .expect(200);
    expect((list.body.data ?? list.body)).toHaveLength(1);

    /**
     * The row survives with a tombstone. That is the right behaviour for a
     * record other tables reference — a merge snapshot names contacts it moved
     * — but it means "deleted" here does not mean erased, and an erasure
     * request needs a different path. Asserted so nobody mistakes one for the
     * other.
     */
    const row = await contactRow(contactId);
    expect(row).toBeDefined();
    expect(row!.deletedAt).not.toBeNull();
    expect(row!.email).toBe("vaidehi@logistics.invalid");
  }, 120_000);

  it("will not read, patch or delete across a tenant boundary", async () => {
    /**
     * 404, never 403, on every one of the four. `loadParty` and `loadContact`
     * both scope by organisation and raise NotFound, so a real id belonging to
     * somebody else has to be indistinguishable from an id that never existed.
     */
    const madeUpParty = randomUUID();
    const madeUpContact = randomUUID();

    for (const probeParty of [neighbourPartyId, madeUpParty]) {
      await http()
        .get(`/party/parties/${probeParty}/contacts`)
        .set("Authorization", `Bearer ${stewardToken}`)
        .expect(404);

      await http()
        .post(`/party/parties/${probeParty}/contacts`)
        .set("Authorization", `Bearer ${stewardToken}`)
        .set("Idempotency-Key", `contact-cross-${probeParty}`)
        .send({ partyId: probeParty, firstName: "Intruder" })
        .expect(404);
    }

    for (const probeContact of [neighbourContactId, madeUpContact]) {
      await http()
        .patch(`/party/contacts/${probeContact}`)
        .set("Authorization", `Bearer ${stewardToken}`)
        .set("Idempotency-Key", `contact-cross-patch-${probeContact}`)
        .send({ firstName: "Tampered" })
        .expect(404);

      await http()
        .delete(`/party/contacts/${probeContact}`)
        .set("Authorization", `Bearer ${stewardToken}`)
        .set("Idempotency-Key", `contact-cross-delete-${probeContact}`)
        .expect(404);
    }

    /** Their person is exactly as they left it. */
    const theirs = await contactRow(neighbourContactId);
    expect(theirs!.firstName).toBe("Someone");
    expect(theirs!.deletedAt).toBeNull();
    expect(await contactsOfParty(neighbour.orgId, neighbourPartyId)).toHaveLength(1);

    /** And they can still read it themselves, so the 404 above was scoping, not breakage. */
    const own = await http()
      .get(`/party/parties/${neighbourPartyId}/contacts`)
      .set("Authorization", `Bearer ${neighbourToken}`)
      .expect(200);
    expect((own.body.data ?? own.body)).toHaveLength(1);
  }, 120_000);
});
