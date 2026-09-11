import { randomUUID, createHash } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { auditLogs } from "src/db/schema";
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
 * A consent change that no user made still has to be recorded — with its audit
 * entry, in the same transaction.
 *
 * The public unsubscribe endpoint (`CrmPublicConsentController.unsubscribe`) is
 * `@Public()` and passes `recordedByUserId: null`, because there is no signed-in
 * user on the other end of an unsubscribe link. `record` closes with an awaited
 * `logCritical`, whose whole contract is that a lost security audit fails the
 * mutation — so if the audit row cannot be written, the opt-out is not recorded
 * either. Nothing is stored, and the person who clicked keeps receiving mail.
 *
 * That was the state of it: the audit entry attributed the absent actor as the
 * literal string "system", `audit_logs.user_id` was NOT NULL with a foreign key
 * to `users`, and no migration or seed creates a user with that id. Every
 * unattributed critical audit write raised 23503 and rolled its caller back.
 *
 * So this asserts both halves of the fix. The unattributed path writes its
 * consent row, its event, its durable suppression hash AND an audit row with a
 * null actor that names the system that acted. The attributed path still
 * records the real user id, because a fix that stopped attributing signed-in
 * actors would be worse than the bug.
 *
 * Run with:
 *   DATABASE_URL=postgres://owner@host/db \
 *   APP_DATABASE_URL=postgres://streamline_app@host/db \
 *   node --max-old-space-size=12288 ./node_modules/jest/bin/jest.js \
 *     --config ./jest-e2e-seeded.json --forceExit --runInBand \
 *     --testPathPattern=crm-consent-unattributed-audit
 */

const hashAddress = (address: string) =>
  createHash("sha256").update(address.trim().toLowerCase()).digest("hex");

describe(`${SEEDED_HARNESS} a consent change nobody signed in for`, () => {
  let seeded: SeededE2eApp;
  let fixture: SeededFixture;
  let consent: CrmConsentService;
  let member = "";

  /** Two contacts, so the anonymous and attributed paths cannot mask each other. */
  const anonContactId = Math.floor(Math.random() * 1_000_000) + 7_000_000;
  const userContactId = anonContactId + 1;
  const anonEmail = `anon-optout-${randomUUID().slice(0, 8)}@test.invalid`;
  const userEmail = `user-optout-${randomUUID().slice(0, 8)}@test.invalid`;

  beforeAll(async () => {
    seeded = await createSeededE2eApp();
    fixture = await seedOrg(seeded.seedDb).addMember("operator", { permissionKeys: [] }).build();
    consent = seeded.app.get(CrmConsentService);
    member = fixture.members["operator"]!.userId;

    for (const [contactId, email, name] of [
      [anonContactId, anonEmail, "Unsubscribe-link probe"],
      [userContactId, userEmail, "Signed-in probe"],
    ] as const) {
      const partyId = randomUUID();
      await seeded.seedDb
        .insert(businessParties)
        .values({ partyId, organizationId: fixture.orgId, name, email });
      await seeded.seedDb
        .insert(contactPartyMap)
        .values({ organizationId: fixture.orgId, contactId, partyId });
    }
  }, 240_000);

  afterAll(async () => {
    if (fixture) {
      await seeded.seedDb.delete(auditLogs).where(eq(auditLogs.orgId, fixture.orgId));
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

  const consentAudit = (userIdIsNull: boolean) =>
    seeded.seedDb
      .select({
        userId: auditLogs.userId,
        targetId: auditLogs.targetId,
        metadata: auditLogs.metadata,
      })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.orgId, fixture.orgId),
          eq(auditLogs.action, "crm.consent.recorded"),
          userIdIsNull ? isNull(auditLogs.userId) : eq(auditLogs.userId, member),
        ),
      )
      .orderBy(desc(auditLogs.id))
      .limit(1);

  it("records the opt-out with no user attached", async () => {
    await asTenant(() =>
      consent.record(fixture.orgId, {
        contactId: anonContactId,
        channel: "EMAIL",
        status: "OPTED_OUT",
        source: "UNSUBSCRIBE_LINK",
        legalBasis: "CONSENT",
        recordedByUserId: null,
      }),
    );

    const [row] = await seeded.seedDb
      .select({ status: crmContactChannelConsent.status })
      .from(crmContactChannelConsent)
      .where(
        and(
          eq(crmContactChannelConsent.orgId, fixture.orgId),
          eq(crmContactChannelConsent.contactId, anonContactId),
          eq(crmContactChannelConsent.channel, "EMAIL"),
        ),
      );

    expect(row?.status).toBe("OPTED_OUT");
  }, 120_000);

  it("writes the durable suppression hash in the same transaction", async () => {
    /**
     * The half that survives erasure. It is written inside `record`'s
     * transaction, so a rolled-back audit takes it with the consent row — which
     * is why it belongs in this test and not only in the erasure one.
     */
    const [row] = await seeded.seedDb
      .select({ reason: crmSuppressionHashes.reason })
      .from(crmSuppressionHashes)
      .where(
        and(
          eq(crmSuppressionHashes.orgId, fixture.orgId),
          eq(crmSuppressionHashes.addressHash, hashAddress(anonEmail)),
        ),
      );

    expect(row).toBeDefined();
    expect(row!.reason).toContain("UNSUBSCRIBE_LINK");
  }, 60_000);

  it("writes the audit entry with a null actor that names the system", async () => {
    const [row] = await consentAudit(true);

    expect(row).toBeDefined();
    expect(row!.userId).toBeNull();
    expect(row!.targetId).toBe(String(anonContactId));
    /**
     * Null alone would read as missing data. The label says which unattended
     * path recorded it, so a reviewer reading the audit log can tell an
     * unsubscribe link from an import.
     */
    expect(row!.metadata).toMatchObject({ systemActor: "crm.consent.UNSUBSCRIBE_LINK" });
  }, 60_000);

  it("still attributes a consent change a signed-in user did make", async () => {
    await asTenant(() =>
      consent.record(fixture.orgId, {
        contactId: userContactId,
        channel: "EMAIL",
        status: "OPTED_OUT",
        source: "USER_ENTRY",
        legalBasis: "CONSENT",
        recordedByUserId: member,
      }),
    );

    const [row] = await consentAudit(false);

    expect(row).toBeDefined();
    expect(row!.userId).toBe(member);
    expect(row!.targetId).toBe(String(userContactId));
    /** An attributed write never claims a system actor. */
    expect(row!.metadata).not.toHaveProperty("systemActor");
  }, 120_000);
});
