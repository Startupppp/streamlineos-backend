import { randomUUID } from "node:crypto";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import {
  crmContactChannelConsent,
  crmContactConsentEvents,
  crmSuppressionHashes,
  orgModules,
} from "src/db/schema";
import { businessParties, contactPartyMap } from "src/db/schema/party";
import { buildUnsubscribeToken } from "src/modules/crm/consent/unsubscribe-token.util";
import {
  SEEDED_HARNESS,
  createSeededE2eApp,
  signSeededToken,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";

/**
 * CRM-UNCALLED-ROUTE-COVERAGE. The four `crm/consent` routes no screen calls.
 *
 * A route-by-route audit of the CRM surface found 39 of 324 routes with no
 * frontend caller, and — worse than the count — found that the controller
 * e2e-specs covering them are 401/402/403 authorisation tables. An
 * authorisation table proves a stranger is refused. It proves nothing about
 * what the route does for the caller who is allowed through, which is the half
 * that rots.
 *
 * These four rank first on blast radius, for two reasons.
 *
 * The first is that consent is the one CRM record with legal weight. Every
 * outbound path in the module resolves through `filterSendable`, which reads
 * exactly the rows `POST /crm/consent/contacts/:contactId` writes. A wrong
 * answer here is not a rendering bug; it is mail sent to somebody who withdrew
 * consent, or mail withheld from somebody who did not.
 *
 * The second is that `POST /crm/consent/unsubscribe` is `@Public()`. It is
 * mounted with no `JwtAuthGuard` at all, which makes it reachable by anybody on
 * the internet holding a link the product itself put in an email footer. "No
 * caller in this frontend" was never evidence a route is dead; this route is
 * the proof, because the callers it exists for are mail clients, and no amount
 * of grepping the frontend could ever have found one.
 *
 * The test that matters most is the fifth. The handler answers `{success:true}`
 * whether the token verifies or not, deliberately, so that the endpoint cannot
 * be used to ask whether a contact exists. That property is invisible in the
 * response — the two cases are byte-identical by design — so the only way to
 * assert it is to look at what reached the database in each case. Nothing had.
 *
 * Run with:
 *   DATABASE_URL=postgres://owner@host/db \
 *   APP_DATABASE_URL=postgres://streamline_app@host/db \
 *   node --max-old-space-size=12288 ./node_modules/jest/bin/jest.js \
 *     --config ./jest-e2e-seeded.json --forceExit --runInBand \
 *     --testPathPattern=crm-consent-uncalled-routes
 */

/** What the guarded three routes require, split the way the controller splits them. */
const OPERATOR_KEYS = ["crm:contacts:view", "crm:contacts:manage"] as const;
/** May read consent, may not record it — the split `@RequirePermission` asserts. */
const READER_KEYS = ["crm:contacts:view"] as const;

describe(`${SEEDED_HARNESS} the consent routes nothing in the product calls`, () => {
  let seeded: SeededE2eApp;
  let fixture: SeededFixture;
  let neighbour: SeededFixture;

  let operatorToken = "";
  let readerToken = "";
  let neighbourToken = "";

  /** Ours. */
  let contactId = 0;
  let contactPartyId = "";
  /** A second contact of ours, left with no consent row, so `missing` has something to count. */
  let uncoveredContactId = 0;
  /** Another tenant's, which we must never be able to touch or read. */
  let neighbourContactId = 0;

  const http = () => request(seeded.app.getHttpServer());

  const consentRows = (orgId: string, forContactId: number) =>
    seeded.seedDb
      .select()
      .from(crmContactChannelConsent)
      .where(
        and(
          eq(crmContactChannelConsent.orgId, orgId),
          eq(crmContactChannelConsent.contactId, forContactId),
        ),
      );

  const eventRows = (orgId: string, forContactId: number) =>
    seeded.seedDb
      .select()
      .from(crmContactConsentEvents)
      .where(
        and(
          eq(crmContactConsentEvents.orgId, orgId),
          eq(crmContactConsentEvents.contactId, forContactId),
        ),
      );

  /**
   * A contact, in the shape the consent reads actually join through.
   *
   * `crm_contact_channel_consent.contact_id` is a bare integer with no foreign
   * key, so a consent row can be written for a contact id that does not exist.
   * The reads — `countMissingConsent`, `suppressedEmails` — reach the person
   * through `contact_party_map` into `business_parties`, so a contact seeded
   * without both halves is invisible to them and every count comes back zero
   * while the spec passes.
   */
  async function seedContact(orgId: string, label: string): Promise<{ contactId: number; partyId: string }> {
    const partyId = randomUUID();
    await seeded.seedDb.insert(businessParties).values({
      partyId,
      organizationId: orgId,
      name: label,
      email: `${label.toLowerCase().replace(/[^a-z0-9]/g, "-")}-${partyId.slice(0, 8)}@consent.invalid`,
    });
    const [row] = await seeded.seedDb
      .insert(contactPartyMap)
      .values({ organizationId: orgId, partyId })
      .returning({ contactId: contactPartyMap.contactId });
    if (!row) throw new Error(`could not seed contact "${label}" for org ${orgId}`);
    return { contactId: row.contactId, partyId };
  }

  beforeAll(async () => {
    seeded = await createSeededE2eApp();

    fixture = await seedOrg(seeded.seedDb)
      .addMember("operator", { permissionKeys: [...OPERATOR_KEYS] })
      .addMember("reader", { permissionKeys: [...READER_KEYS] })
      .build();

    /**
     * A second, entirely separate tenant.
     *
     * Every cross-tenant assertion below needs a record that genuinely exists
     * somewhere else. Probing a random id proves only that random ids are not
     * found; probing a real id in another org is what distinguishes "absent"
     * from "present but not yours", and the second is the answer that must
     * never be distinguishable from the first.
     */
    neighbour = await seedOrg(seeded.seedDb)
      .addMember("operator", { permissionKeys: [...OPERATOR_KEYS] })
      .build();

    /** Every route here carries `@RequireModule("crm")`; without this row it is 402. */
    for (const orgId of [fixture.orgId, neighbour.orgId])
      await seeded.seedDb
        .insert(orgModules)
        .values({ orgId, moduleKey: "crm", enabled: true })
        .onConflictDoNothing();

    operatorToken = await signSeededToken(seeded, fixture.members["operator"]!.userId, fixture.orgId);
    readerToken = await signSeededToken(seeded, fixture.members["reader"]!.userId, fixture.orgId);
    neighbourToken = await signSeededToken(seeded, 
      neighbour.members["operator"]!.userId,
      neighbour.orgId,
    );

    const mine = await seedContact(fixture.orgId, "Consent probe");
    contactId = mine.contactId;
    contactPartyId = mine.partyId;
    uncoveredContactId = (await seedContact(fixture.orgId, "Uncovered probe")).contactId;
    neighbourContactId = (await seedContact(neighbour.orgId, "Neighbour probe")).contactId;
  }, 240_000);

  afterAll(async () => {
    for (const org of [fixture, neighbour]) {
      if (!org) continue;
      await seeded.seedDb
        .delete(crmSuppressionHashes)
        .where(eq(crmSuppressionHashes.orgId, org.orgId));
      await seeded.seedDb
        .delete(crmContactConsentEvents)
        .where(eq(crmContactConsentEvents.orgId, org.orgId));
      await seeded.seedDb
        .delete(crmContactChannelConsent)
        .where(eq(crmContactChannelConsent.orgId, org.orgId));
      await seeded.seedDb
        .delete(contactPartyMap)
        .where(eq(contactPartyMap.organizationId, org.orgId));
      await seeded.seedDb
        .delete(businessParties)
        .where(eq(businessParties.organizationId, org.orgId));
      await org.teardown();
    }
    await seeded?.close();
  }, 60_000);

  it("records an opt-in, and files who recorded it", async () => {
    const response = await http()
      .post(`/crm/consent/contacts/${contactId}`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({
        channel: "EMAIL",
        status: "OPTED_IN",
        source: "USER_ENTRY",
        legalBasis: "CONSENT",
        sourceDetail: "Signed at the trade show desk",
      })
      .expect(200);

    expect(response.body.data ?? response.body).toEqual({ success: true });

    const [row] = await consentRows(fixture.orgId, contactId);
    expect(row).toBeDefined();
    expect(row!.channel).toBe("EMAIL");
    expect(row!.status).toBe("OPTED_IN");
    expect(row!.source).toBe("USER_ENTRY");
    expect(row!.legalBasis).toBe("CONSENT");
    expect(row!.sourceDetail).toBe("Signed at the trade show desk");
    /**
     * §6: the actor is the bearer token's subject and is never accepted from
     * the client. A consent record whose provenance the caller could name is
     * worth nothing to the audit it exists for.
     */
    expect(row!.recordedByUserId).toBe(fixture.members["operator"]!.userId);

    const events = await eventRows(fixture.orgId, contactId);
    expect(events).toHaveLength(1);
    /** No prior row, so no prior status — the transition starts from nothing. */
    expect(events[0]!.fromStatus).toBeNull();
    expect(events[0]!.toStatus).toBe("OPTED_IN");
  }, 120_000);

  it("refuses to let a claimed source forge the provenance", async () => {
    /**
     * `UNSUBSCRIBE_LINK` and `WEB_FORM` are set by the system. An operator who
     * could claim them could make a consent record he typed himself look like
     * one the person gave, which is the single field a DPDP audit relies on.
     */
    await http()
      .post(`/crm/consent/contacts/${contactId}`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ channel: "EMAIL", status: "OPTED_OUT", source: "UNSUBSCRIBE_LINK" })
      .expect(400);

    const rows = await consentRows(fixture.orgId, contactId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("OPTED_IN");
  }, 120_000);

  it("re-recording the same channel updates in place and appends the transition", async () => {
    await http()
      .post(`/crm/consent/contacts/${contactId}`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ channel: "EMAIL", status: "OPTED_OUT", source: "USER_ENTRY" })
      .expect(200);

    /**
     * One row per (org, contact, channel) — the unique index the upsert targets.
     * A second row here would mean `filterSendable` reads whichever the planner
     * happens to return, which is how an opt-out silently stops applying.
     */
    const rows = await consentRows(fixture.orgId, contactId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("OPTED_OUT");
    expect(rows[0]!.legalBasis).toBeNull();
    expect(rows[0]!.sourceDetail).toBeNull();

    const events = await eventRows(fixture.orgId, contactId);
    expect(events).toHaveLength(2);
    const latest = events.sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    )[0]!;
    expect(latest.fromStatus).toBe("OPTED_IN");
    expect(latest.toStatus).toBe("OPTED_OUT");
  }, 120_000);

  it("reads the contact's consent back, and refuses the write to a reader", async () => {
    const response = await http()
      .get(`/crm/consent/contacts/${contactId}`)
      .set("Authorization", `Bearer ${readerToken}`)
      .expect(200);

    const rows = response.body.data ?? response.body;
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0].channel).toBe("EMAIL");
    expect(rows[0].status).toBe("OPTED_OUT");

    /** `crm:contacts:view` reads consent; recording it needs `:manage`. */
    await http()
      .post(`/crm/consent/contacts/${contactId}`)
      .set("Authorization", `Bearer ${readerToken}`)
      .send({ channel: "SMS", status: "OPTED_IN", source: "USER_ENTRY" })
      .expect(403);
  }, 120_000);

  it("counts the contacts with no consent row for the channel", async () => {
    const before = await http()
      .get("/crm/consent/missing?channel=SMS")
      .set("Authorization", `Bearer ${operatorToken}`)
      .expect(200);

    const beforeBody = before.body.data ?? before.body;
    expect(beforeBody.channel).toBe("SMS");
    /** Two contacts seeded, neither with an SMS row. */
    expect(beforeBody.count).toBe(2);

    await http()
      .post(`/crm/consent/contacts/${contactId}`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ channel: "SMS", status: "UNKNOWN", source: "IMPORT" })
      .expect(200);

    const after = await http()
      .get("/crm/consent/missing?channel=SMS")
      .set("Authorization", `Bearer ${operatorToken}`)
      .expect(200);

    /**
     * UNKNOWN is a recorded answer, not a missing one — the metric counts rows
     * that are absent, not rows that say "we do not know". Asserted because the
     * distinction is the whole reason the status enum has three values.
     */
    expect((after.body.data ?? after.body).count).toBe(1);

    /** Its own tenant's contacts only. The neighbour's uncovered contact is not ours to count. */
    const theirs = await http()
      .get("/crm/consent/missing?channel=SMS")
      .set("Authorization", `Bearer ${neighbourToken}`)
      .expect(200);
    expect((theirs.body.data ?? theirs.body).count).toBe(1);
  }, 120_000);

  it("honours a signed unsubscribe link with no session at all", async () => {
    /**
     * The route the frontend cannot call because the caller is a mail client.
     * No Authorization header is sent, deliberately: `@Public()` is the whole
     * point, and a spec that authenticated would be testing a different route.
     */
    const token = buildUnsubscribeToken({
      orgId: fixture.orgId,
      contactId: uncoveredContactId,
      channel: "EMAIL",
    });

    await http()
      .post("/crm/consent/unsubscribe")
      .send({ token })
      .expect(200)
      .expect((res) => {
        expect(res.body.data ?? res.body).toEqual({ success: true });
      });

    const [row] = await consentRows(fixture.orgId, uncoveredContactId);
    expect(row).toBeDefined();
    expect(row!.status).toBe("OPTED_OUT");
    expect(row!.channel).toBe("EMAIL");
    /** Provenance the operator route is forbidden from claiming, set by the system. */
    expect(row!.source).toBe("UNSUBSCRIBE_LINK");
    expect(row!.legalBasis).toBe("CONSENT");
    /** Nobody was signed in; attributing this to a user would be a lie in the audit. */
    expect(row!.recordedByUserId).toBeNull();

    /**
     * CRM-P1-11's guarantee, reached through the public route rather than the
     * service: the address-only copy that outlives erasure of the contact.
     */
    const hashes = await seeded.seedDb
      .select()
      .from(crmSuppressionHashes)
      .where(eq(crmSuppressionHashes.orgId, fixture.orgId));
    expect(hashes.length).toBeGreaterThan(0);
  }, 120_000);

  it("answers a forged token identically, and writes nothing", async () => {
    /**
     * The assertion this whole file exists for.
     *
     * The handler returns `{success:true}` for a token that does not verify, so
     * that the endpoint cannot be asked whether a contact exists. Because the
     * two responses are identical by design, the only observable difference is
     * in the database, and nothing had ever looked there. A regression that
     * started returning 404 for a bad token would pass every existing test and
     * hand an unauthenticated caller an existence oracle over every contact in
     * every tenant.
     */
    const genuine = buildUnsubscribeToken({
      orgId: fixture.orgId,
      contactId,
      channel: "WHATSAPP",
    });
    /** Same payload, signature flipped: a caller who guessed the shape but not the key. */
    const forged = `${genuine.slice(0, genuine.lastIndexOf(".") + 1)}${"A".repeat(43)}`;

    const eventsBefore = await eventRows(fixture.orgId, contactId);

    const response = await http()
      .post("/crm/consent/unsubscribe")
      .send({ token: forged })
      .expect(200);

    expect(response.body.data ?? response.body).toEqual({ success: true });

    const whatsapp = (await consentRows(fixture.orgId, contactId)).filter(
      (row) => row.channel === "WHATSAPP",
    );
    expect(whatsapp).toHaveLength(0);
    expect(await eventRows(fixture.orgId, contactId)).toHaveLength(eventsBefore.length);
  }, 120_000);

  it("will not let one tenant read or write another tenant's consent", async () => {
    /**
     * 404, never 403.
     *
     * A 403 says "this exists and is not yours", which turns any id into an
     * existence oracle for a competitor's customer list. The consent reads
     * scope by `org_id` rather than checking-then-refusing, so the neighbour's
     * real contact id has to read as absent — an empty list, not a rejection.
     */
    const asStranger = await http()
      .get(`/crm/consent/contacts/${neighbourContactId}`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .expect(200);
    expect(asStranger.body.data ?? asStranger.body).toEqual([]);

    /** And their contact keeps whatever it had, which is nothing. */
    expect(await consentRows(neighbour.orgId, neighbourContactId)).toHaveLength(0);

    /**
     * A token minted for our tenant names our tenant. Even holding a valid
     * signature, it cannot be pointed at somebody else's contact: the payload
     * carries the org, and the write lands there or nowhere.
     */
    const crossOrgToken = buildUnsubscribeToken({
      orgId: fixture.orgId,
      contactId: neighbourContactId,
      channel: "SMS",
    });
    await http().post("/crm/consent/unsubscribe").send({ token: crossOrgToken }).expect(200);

    expect(await consentRows(neighbour.orgId, neighbourContactId)).toHaveLength(0);
  }, 120_000);

  it("keeps the party behind the contact attached to the row", async () => {
    /**
     * `contact_party_id` is ticket 08's expand column, kept in step by a
     * trigger rather than by the writer. Nothing asserted the trigger fires on
     * this table, and a consent row that lost its party is a row the identity
     * surface cannot show — the failure mode is a blank, not an error.
     */
    const [row] = await consentRows(fixture.orgId, contactId);
    expect(row!.contactPartyId).toBe(contactPartyId);
  }, 120_000);
});
