import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { organizations } from "src/db/schema";
import { businessParties } from "src/db/schema/party";
import { OutboundService } from "src/modules/autonomy/outbound.service";
import { evaluateGuardrails, resolveTimezone } from "src/modules/autonomy/send-guardrails";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import {
  SEEDED_HARNESS,
  createSeededE2eApp,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";

/**
 * CRM-P1-09. The working-hours gate now reads the customer's clock.
 *
 * `resolveTimezone` has always preferred the party's zone over the tenant's and
 * reported which it used, and `crm_outbound_messages` records `timezone_used`
 * and `timezone_source` for every send. Nothing could set the party half:
 * no table recorded a zone, so `sendTimeFacts` returned a hardcoded
 * `partyTimezone: null` and every working-hours decision was made in the
 * sender's zone. A Delhi tenant mailing a Californian customer at 10am local
 * was reaching them at half past nine the previous evening.
 *
 * What is proved here is the wiring, because the decision logic already has
 * unit coverage: the column reaches `SendTimeFacts`, a correction during the
 * hold window is honoured, and an unknown zone still degrades to the tenant's
 * rather than to UTC or to a guess.
 *
 * The last test pins `now` rather than using the clock. Working hours are
 * 09:00-17:00 Mon-Fri, so whether two zones disagree depends on the instant —
 * two zones 26 hours apart are only 2 hours apart in local time and usually
 * agree. At 06:00 UTC on a Wednesday it is 11:30 Wed in Kolkata and 23:00 Tue
 * in Los Angeles: one inside the window, one outside, every time this runs.
 *
 * Run with:
 *   DATABASE_URL=postgres://owner@host/db \
 *   APP_DATABASE_URL=postgres://streamline_app@host/db \
 *   node --max-old-space-size=12288 ./node_modules/jest/bin/jest.js \
 *     --config ./jest-e2e-seeded.json --forceExit --runInBand \
 *     --testPathPattern=crm-party-timezone
 */

describe(`${SEEDED_HARNESS} the send gate reads the party's own clock`, () => {
  let seeded: SeededE2eApp;
  let fixture: SeededFixture;
  let outbound: OutboundService;
  let partyId = "";

  const message = () => ({
    outboundMessageId: randomUUID(),
    partyId,
    contactId: null,
    dealId: null,
    outboundClass: "nudge" as const,
    draftedAt: new Date(),
    workingHourDeferrals: 0,
    recipientEmail: null,
  });

  const factsNow = () =>
    runInNewTenantTransaction(seeded.seedDb, fixture.orgId, () =>
      outbound.sendTimeFacts(fixture.orgId, message()),
    );

  const setPartyTimezone = (timezone: string | null) =>
    seeded.seedDb
      .update(businessParties)
      .set({ timezone })
      .where(eq(businessParties.partyId, partyId));

  beforeAll(async () => {
    seeded = await createSeededE2eApp();
    fixture = await seedOrg(seeded.seedDb).addMember("operator", { permissionKeys: [] }).build();
    outbound = seeded.app.get(OutboundService);

    await seeded.seedDb
      .update(organizations)
      .set({ timezone: "Asia/Kolkata" })
      .where(eq(organizations.id, fixture.orgId));

    partyId = randomUUID();
    await seeded.seedDb.insert(businessParties).values({
      partyId,
      organizationId: fixture.orgId,
      name: "Timezone probe",
    });
  }, 240_000);

  afterAll(async () => {
    if (fixture) {
      await seeded.seedDb
        .delete(businessParties)
        .where(eq(businessParties.organizationId, fixture.orgId));
      await fixture.teardown();
    }
    await seeded?.close();
  }, 60_000);

  it("falls back to the tenant's zone when nobody recorded one", async () => {
    await setPartyTimezone(null);
    const facts = await factsNow();

    expect(facts.partyTimezone).toBeNull();
    expect(resolveTimezone(facts)).toEqual({ timeZone: "Asia/Kolkata", source: "tenant" });
  }, 120_000);

  it("uses the party's zone once one is recorded", async () => {
    await setPartyTimezone("America/Los_Angeles");
    const facts = await factsNow();

    /** The value that was hardcoded null before this ticket. */
    expect(facts.partyTimezone).toBe("America/Los_Angeles");
    expect(resolveTimezone(facts)).toEqual({
      timeZone: "America/Los_Angeles",
      source: "party",
    });
  }, 120_000);

  it("honours a correction made during the hold window", async () => {
    /**
     * The reason this is read at send time and not carried on the draft: a
     * message can wait hours, and somebody may fix a wrong zone while it does.
     */
    await setPartyTimezone("Europe/Berlin");
    expect((await factsNow()).partyTimezone).toBe("Europe/Berlin");

    await setPartyTimezone("Australia/Sydney");
    expect((await factsNow()).partyTimezone).toBe("Australia/Sydney");
  }, 120_000);

  it("degrades to the tenant's zone if the stored zone stops being recognised", async () => {
    /**
     * Written straight to the column, bypassing the API's validation, because
     * that is the real shape of the risk: tzdata drops a zone that was valid
     * when it was saved. It must not throw at send time, and it must not fall
     * to UTC — a tenant's working day is a far better guess at a customer's
     * than midnight-to-midnight in Greenwich.
     */
    await setPartyTimezone("Mars/Olympus_Mons");
    const facts = await factsNow();

    expect(facts.partyTimezone).toBe("Mars/Olympus_Mons");
    expect(resolveTimezone(facts)).toEqual({ timeZone: "Asia/Kolkata", source: "tenant" });
  }, 120_000);

  it("changes the actual send decision, not just the reported zone", async () => {
    /**
     * The whole point of the ticket: the customer's clock decides, so the same
     * message at the same instant is sent to one party and held for another.
     */
    const base = await factsNow();
    const at = (partyTimezone: string) =>
      evaluateGuardrails({
        ...base,
        /** Fixed, so this asserts the zone and not the hour the suite happened to run. */
        now: new Date("2026-09-09T06:00:00.000Z"),
        partyTimezone,
        consent: "OPTED_IN",
        suppressed: false,
        classStopped: false,
        recentSendsToParty: [],
        repliedAt: null,
        deferralsSoFar: 0,
      });

    /** 11:30 on a Wednesday — inside 09:00-17:00. */
    expect(at("Asia/Kolkata").allow).toBe(true);

    /** 23:00 the previous evening — the message a null zone would have sent. */
    const california = at("America/Los_Angeles");
    expect(california.allow).toBe(false);
    expect(california.allow === false ? california.reason : null).toBe("outside-working-hours");
  }, 120_000);
});
