import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  crmContactChannelConsent,
  crmContactConsentEvents,
  crmSuppressionHashes,
} from "src/db/schema";
import { businessParties, contactPartyMap } from "src/db/schema/party";
import { CrmConsentService } from "src/modules/crm/consent/crm-consent.service";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import {
  SEEDED_HARNESS,
  createSeededE2eApp,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";

/**
 * CRM-P1-11. An opt-out has to outlive the record it was captured on.
 *
 * `crm_contact_channel_consent` is keyed on `contact_id`. A contact erased
 * under a DPDP request takes its opt-out with it, so if the same address is
 * imported again the consent query finds nothing and mail resumes to somebody
 * who withdrew consent.
 *
 * `crm_suppression_hashes` exists to survive exactly that, and both readers
 * already union it in — `CrmConsentService.suppressedEmails`, and
 * `OutboundService.isSuppressed` at send time, whose comment says checking one
 * and not the other "would let a re-imported address resume receiving mail".
 * Nothing had ever written a row. That half of both queries was permanently
 * empty and the union added nothing.
 *
 * The last test is the one that matters: it deletes the contact and the party
 * and asks again. Everything before it would pass with the hash table still
 * empty, because the consent row alone answers while the contact exists.
 *
 * Every opt-out here is attributed to a real member, because the anonymous path
 * cannot run at all — see the note on `recordedBy` below. That is a separate,
 * pre-existing defect, reported rather than worked around here.
 *
 * Run with:
 *   DATABASE_URL=postgres://owner@host/db \
 *   APP_DATABASE_URL=postgres://streamline_app@host/db \
 *   node --max-old-space-size=12288 ./node_modules/jest/bin/jest.js \
 *     --config ./jest-e2e-seeded.json --forceExit --runInBand \
 *     --testPathPattern=crm-optout-survives-erasure
 */

const hashAddress = (address: string) =>
  createHash("sha256").update(address.trim().toLowerCase()).digest("hex");

describe(`${SEEDED_HARNESS} an opt-out outlives the contact who made it`, () => {
  let seeded: SeededE2eApp;
  let fixture: SeededFixture;
  let consent: CrmConsentService;

  /**
   * A real member, because `record` cannot run without one.
   *
   * Its audit call is `logCritical`, which is awaited and rolls the mutation
   * back on failure, and it attributes an absent actor as the literal string
   * "system" — while `audit_logs.user_id` is NOT NULL with a foreign key to
   * `users`, and nothing anywhere creates a user with that id. So a consent
   * change with no user attached throws and records nothing, which is the state
   * the public unsubscribe endpoint is in: it passes `recordedByUserId: null`.
   * Reported separately; it is a platform-wide convention (119 logCritical call
   * sites, plus `systemActor`) and not this ticket's to change.
   */
  let recordedBy = "";

  const contactId = Math.floor(Math.random() * 1_000_000) + 9_000_000;
  const email = `optout-${randomUUID().slice(0, 8)}@test.invalid`;
  let partyId = "";

  beforeAll(async () => {
    seeded = await createSeededE2eApp();
    fixture = await seedOrg(seeded.seedDb).addMember("operator", { permissionKeys: [] }).build();
    consent = seeded.app.get(CrmConsentService);
    recordedBy = fixture.members["operator"]!.userId;

    partyId = randomUUID();
    await seeded.seedDb.insert(businessParties).values({
      partyId,
      organizationId: fixture.orgId,
      name: "Opt-out probe",
      email,
    });
    await seeded.seedDb.insert(contactPartyMap).values({
      organizationId: fixture.orgId,
      contactId,
      partyId,
    });
  }, 240_000);

  afterAll(async () => {
    if (fixture) {
      await seeded.seedDb
        .delete(crmSuppressionHashes)
        .where(eq(crmSuppressionHashes.orgId, fixture.orgId));
      await seeded.seedDb
        .delete(crmContactConsentEvents)
        .where(eq(crmContactConsentEvents.orgId, fixture.orgId));
      await seeded.seedDb
        .delete(crmContactChannelConsent)
        .where(eq(crmContactChannelConsent.orgId, fixture.orgId));
      await seeded.seedDb
        .delete(contactPartyMap)
        .where(eq(contactPartyMap.organizationId, fixture.orgId));
      await seeded.seedDb
        .delete(businessParties)
        .where(eq(businessParties.organizationId, fixture.orgId));
      await fixture.teardown();
    }
    await seeded?.close();
  }, 60_000);

  /** The service reads through the tenant-scoped db, so give it a tenant. */
  const asTenant = <T>(fn: () => Promise<T>): Promise<T> =>
    runInNewTenantTransaction(seeded.seedDb, fixture.orgId, () => fn());

  it("records the opt-out", async () => {
    await asTenant(() =>
      consent.record(fixture.orgId, {
        contactId,
        channel: "EMAIL",
        status: "OPTED_OUT",
        source: "UNSUBSCRIBE_LINK",
        legalBasis: "CONSENT",
        recordedByUserId: recordedBy,
      }),
    );

    const suppressed = await asTenant(() => consent.suppressedEmails(fixture.orgId, [email]));
    expect(suppressed.has(email)).toBe(true);
  }, 120_000);

  it("writes the address-only copy alongside it", async () => {
    const [row] = await seeded.seedDb
      .select({ reason: crmSuppressionHashes.reason, channel: crmSuppressionHashes.channel })
      .from(crmSuppressionHashes)
      .where(
        and(
          eq(crmSuppressionHashes.orgId, fixture.orgId),
          eq(crmSuppressionHashes.addressHash, hashAddress(email)),
        ),
      );

    expect(row).toBeDefined();
    expect(row!.channel).toBe("EMAIL");
    /** Says where it came from, so a reviewer can tell an opt-out from a bounce. */
    expect(row!.reason).toContain("UNSUBSCRIBE_LINK");
  }, 60_000);

  it("stores a hash, never the address", async () => {
    /**
     * The whole reason this table can outlive an erasure request: there is no
     * personal data left in it to erase.
     */
    const rows = await seeded.seedDb
      .select({ addressHash: crmSuppressionHashes.addressHash })
      .from(crmSuppressionHashes)
      .where(eq(crmSuppressionHashes.orgId, fixture.orgId));

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.addressHash).not.toContain("@");
      expect(row.addressHash).toMatch(/^[0-9a-f]{64}$/);
    }
  }, 60_000);

  it("does not write a second row when the same opt-out is recorded again", async () => {
    await asTenant(() =>
      consent.record(fixture.orgId, {
        contactId,
        channel: "EMAIL",
        status: "OPTED_OUT",
        source: "UNSUBSCRIBE_LINK",
        recordedByUserId: recordedBy,
      }),
    );

    const rows = await seeded.seedDb
      .select({ addressHash: crmSuppressionHashes.addressHash })
      .from(crmSuppressionHashes)
      .where(
        and(
          eq(crmSuppressionHashes.orgId, fixture.orgId),
          eq(crmSuppressionHashes.addressHash, hashAddress(email)),
        ),
      );

    expect(rows).toHaveLength(1);
  }, 60_000);

  it("still suppresses the address after the contact is erased", async () => {
    /**
     * The test the others are scaffolding for. Everything above passes with
     * the hash table empty, because while the contact exists the consent row
     * answers on its own. Erase it and only the durable copy is left — which
     * is the state a re-import lands in.
     */
    /**
     * Consent rows go first, and they have to.
     *
     * `fk_crm_contact_channel_consent_contact_party_id` is a COMPOSITE foreign
     * key on (org_id, contact_party_id) with ON DELETE SET NULL, and Postgres
     * nulls every column of a composite key — including `org_id`, which is NOT
     * NULL. So deleting a party that has consent rows fails outright. That is
     * its own defect, reported separately; here it only means an erasure must
     * clear consent before the party, which is what an erasure does anyway and
     * is exactly the state this test is about. The event log carries the same
     * constraint, so it goes too.
     */
    await seeded.seedDb
      .delete(crmContactConsentEvents)
      .where(
        and(
          eq(crmContactConsentEvents.orgId, fixture.orgId),
          eq(crmContactConsentEvents.contactId, contactId),
        ),
      );
    await seeded.seedDb
      .delete(crmContactChannelConsent)
      .where(
        and(
          eq(crmContactChannelConsent.orgId, fixture.orgId),
          eq(crmContactChannelConsent.contactId, contactId),
        ),
      );
    await seeded.seedDb
      .delete(contactPartyMap)
      .where(
        and(
          eq(contactPartyMap.organizationId, fixture.orgId),
          eq(contactPartyMap.contactId, contactId),
        ),
      );
    await seeded.seedDb
      .delete(businessParties)
      .where(eq(businessParties.partyId, partyId));

    const suppressed = await asTenant(() => consent.suppressedEmails(fixture.orgId, [email]));
    expect(suppressed.has(email)).toBe(true);
  }, 120_000);

  it("does not suppress an address nobody opted out", async () => {
    /** Otherwise "still suppressed" above could just mean "suppresses everything". */
    const other = `never-${randomUUID().slice(0, 8)}@test.invalid`;
    const suppressed = await asTenant(() => consent.suppressedEmails(fixture.orgId, [other]));
    expect(suppressed.has(other)).toBe(false);
  }, 60_000);
});
