import {
  autonomySwitches,
  businessParties,
  crmColdOutboundSettings,
  crmOutboundClassStops,
  crmOutboundMessages,
  crmSendingDomains,
  partyContacts,
} from "../../db/schema";
import { tenantDb, type TenantFixture } from "../../test/tenant-recorder";
import { OutboundService } from "./outbound.service";

/**
 * Cross-tenant isolation for the autonomous outbound loop.
 *
 * `composeAndHold` is the call that turns a customer into a model prompt and a
 * held email, so the first thing it must never do is accept another org's
 * customer. The rest of the service answers the guardrail questions a send is
 * gated on — who to write to, whether cold sending is on and warm, what has
 * already been sent, whether a person stopped this class, whether the kill
 * switch is thrown — and each answer must come from the caller's own org only.
 *
 * The fixtures hold the OWNER's customer, contact, cold-sending setup, sent
 * message, class stop and kill switch. The double answers each statement by the
 * equalities it bound, so a missing org predicate hands those to the attacker.
 */

const OWNER_ORG = "org-owner";
const ATTACKER_ORG = "org-attacker";
const RECENT = new Date(Date.now() - 60 * 60 * 1000);

const OWNER_SWITCH: TenantFixture = {
  table: autonomySwitches,
  org: autonomySwitches.organizationId,
  rows: [{ organizationId: OWNER_ORG, kind: "outbound.sent", enabled: false, reason: "owner paused outbound" }],
};

function build(opts: { switches?: boolean } = {}) {
  const fixtures: TenantFixture[] = [
    {
      table: businessParties,
      org: businessParties.organizationId,
      rows: [
        { organizationId: OWNER_ORG, partyId: "party-owner", name: "Owner buyer", companyName: "Owner Co", email: "buyer@owner.test", timezone: "Asia/Kolkata" },
        { organizationId: ATTACKER_ORG, partyId: "party-attacker", name: "Attacker buyer", companyName: null, email: "buyer@attacker.test", timezone: null },
      ],
    },
    {
      table: partyContacts,
      org: partyContacts.organizationId,
      rows: [{ organizationId: OWNER_ORG, partyId: "party-owner", email: "ceo@owner.test", isPrimary: true, deletedAt: null }],
    },
    {
      table: crmColdOutboundSettings,
      org: crmColdOutboundSettings.organizationId,
      rows: [{ organizationId: OWNER_ORG, enabled: true, pausedAt: null }],
    },
    {
      table: crmSendingDomains,
      org: crmSendingDomains.organizationId,
      rows: [
        { organizationId: OWNER_ORG, domain: "cold.owner.test", purpose: "cold", verifiedAt: new Date("2026-08-01"), warmupStartedAt: new Date("2026-08-01") },
      ],
    },
    {
      table: crmOutboundMessages,
      org: crmOutboundMessages.organizationId,
      rows: [{ organizationId: OWNER_ORG, partyId: "party-owner", track: "cold", status: "sent", sentAt: RECENT, count: 7 }],
    },
    {
      table: crmOutboundClassStops,
      org: crmOutboundClassStops.organizationId,
      rows: [{ organizationId: OWNER_ORG, partyId: "party-owner", outboundClass: "follow_up", releasedAt: null, id: "stop-owner" }],
    },
    ...(opts.switches === false ? [] : [OWNER_SWITCH]),
  ];
  const t = tenantDb({ fixtures });
  const gateway = { invokeStructuredWithUsage: jest.fn() };
  /** Answers "not suppressed" to whatever the service asks, without naming a method it may not have. */
  const suppression = new Proxy({}, { get: () => jest.fn(async () => false) });
  const service = new OutboundService(t.db, gateway as never, {} as never, {} as never, suppression as never);
  return { t, gateway, service };
}

const sendFacts = (partyId: string) => ({
  outboundMessageId: "msg-x",
  partyId,
  contactId: null,
  dealId: null,
  outboundClass: "follow_up" as never,
  draftedAt: new Date(),
  workingHourDeferrals: 0,
  recipientEmail: null,
});

describe("OutboundService — cross-tenant isolation", () => {
  it("deny: composing for another org's customer is 'not on file' and never reaches the model", async () => {
    const { t, gateway, service } = build();

    const outcome = await service.composeAndHold({ organizationId: ATTACKER_ORG, partyId: "party-owner" });

    expect(outcome).toEqual({ held: false, stage: "eligibility", reason: "That customer is not on file." });
    expect(gateway.invokeStructuredWithUsage).not.toHaveBeenCalled();
    expect(t.statements.filter((s) => s.op !== "select")).toHaveLength(0);
    expect(t.orgBound(t.on(businessParties, "select")[0], businessParties.organizationId)).toEqual([ATTACKER_ORG]);
  });

  it("deny: another org's customer resolves to no recipient address", async () => {
    const { t, service } = build();

    expect(await service.resolveRecipient(ATTACKER_ORG, "party-owner")).toBeNull();
    expect(t.orgBound(t.on(partyContacts, "select")[0], partyContacts.organizationId)).toEqual([ATTACKER_ORG]);
    expect(t.orgBound(t.on(businessParties, "select")[0], businessParties.organizationId)).toEqual([ATTACKER_ORG]);
  });

  it("deny: another org's cold-sending setup and volume never become the caller's", async () => {
    const { t, service } = build();

    const facts = await service.coldTrackFacts(ATTACKER_ORG);

    expect(facts).toMatchObject({ enabled: false, pausedAt: null, domain: null, sentToday: 0 });
    expect(t.orgBound(t.on(crmColdOutboundSettings, "select")[0], crmColdOutboundSettings.organizationId)).toEqual([ATTACKER_ORG]);
    expect(t.orgBound(t.on(crmSendingDomains, "select")[0], crmSendingDomains.organizationId)).toEqual([ATTACKER_ORG]);
    expect(t.orgBound(t.on(crmOutboundMessages, "select")[0], crmOutboundMessages.organizationId)).toEqual([ATTACKER_ORG]);
  });

  it("deny: another org's class stop, send history and customer timezone never gate the caller's send", async () => {
    const { t, service } = build();

    const facts = await service.sendTimeFacts(ATTACKER_ORG, sendFacts("party-owner"));

    expect(facts).toMatchObject({ classStopped: false, recentSendsToParty: [], partyTimezone: null });
    expect(t.orgBound(t.on(crmOutboundClassStops, "select")[0], crmOutboundClassStops.organizationId)).toEqual([ATTACKER_ORG]);
    expect(t.orgBound(t.on(crmOutboundMessages, "select")[0], crmOutboundMessages.organizationId)).toEqual([ATTACKER_ORG]);
  });

  it("deny: another org's kill switch has no effect on the caller's answer", async () => {
    const withOwnerSwitch = build();
    const withNoSwitches = build({ switches: false });

    const allowed = await withOwnerSwitch.service.switchAllows(ATTACKER_ORG, "follow_up" as never);

    expect(allowed).toBe(await withNoSwitches.service.switchAllows(ATTACKER_ORG, "follow_up" as never));
    expect(withOwnerSwitch.t.orgBound(withOwnerSwitch.t.on(autonomySwitches, "select")[0], autonomySwitches.organizationId)).toEqual([
      ATTACKER_ORG,
    ]);
  });

  it("deny: pausing the cold track writes only the caller's settings row", async () => {
    const { t, service } = build();

    await service.pauseColdTrack(ATTACKER_ORG, "complaint rate");

    expect(t.inserted(crmColdOutboundSettings)).toEqual([
      expect.objectContaining({ organizationId: ATTACKER_ORG, enabled: false, pauseReason: "complaint rate" }),
    ]);
    const upsert = t.on(crmColdOutboundSettings, "insert")[0]!.calls.find((call) => call.method === "onConflictDoUpdate");
    expect((upsert!.args[0] as { target: unknown }).target).toBe(crmColdOutboundSettings.organizationId);
  });

  it("control: the owning org resolves its own recipient and cold-sending setup, and its own stop gates its send", async () => {
    const { service } = build();

    expect(await service.resolveRecipient(OWNER_ORG, "party-owner")).toBe("ceo@owner.test");
    expect(await service.coldTrackFacts(OWNER_ORG)).toMatchObject({
      enabled: true,
      domain: expect.objectContaining({ domain: "cold.owner.test" }),
      sentToday: 7,
    });
    expect(await service.sendTimeFacts(OWNER_ORG, sendFacts("party-owner"))).toMatchObject({
      classStopped: true,
      recentSendsToParty: [RECENT],
      partyTimezone: "Asia/Kolkata",
    });
  });
});
