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
 * Every opt-out here is attributed to a real member. The unattributed path — the
 * public unsubscribe link, which has no signed-in user — could not run at all
 * when this was written; it is fixed and covered by
 * `crm-consent-unattributed-audit.seeded-e2e-spec.ts`.
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
   * A real member: this file is about an opt-out outliving its contact, so it
   * holds the actor constant and varies the erasure. The unattributed actor is
   * its own case, covered by `crm-consent-unattributed-audit`.
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
     * key on (org_id, contact_party_id). It used to declare ON DELETE SET NULL,
     * and Postgres nulls every column of a composite key — including `org_id`,
     * which is NOT NULL — so deleting a party with consent rows aborted on a
     * not-null violation against this table. That defect is fixed in 0662: the
     * key is now NO ACTION, so the delete is still refused but the error names
     * the blocking table instead of a null `org_id`, and
     * `check:composite-fk-set-null` keeps it from coming back.
     *
     * The ordering here is unchanged and is not a workaround: NO ACTION is the
     * deliberate choice for the erasure path, because `subject-request-plan.ts`
     * requires a disposition to be declared per table and executed explicitly
     * rather than performed silently by a cascade. An erasure clears consent
     * before the party, which is what an erasure does anyway and is exactly the
     * state this test is about. The event log carries the same constraint, so
     * it goes too.
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
