import type { Db } from "../../db/drizzle.types";
import {
  autonomousDecisions,
  autonomyHolds,
  businessParties,
  crmOutboundMessages,
  deals,
  partyContacts,
  relationshipStates,
  workflowRuns,
} from "../../db/schema";
import type { AiGatewayService } from "../ai/core/gateway/ai-gateway.service";
import type { EmailSuppressionService } from "../email/email-suppression.service";
import type { NotificationsService } from "../notifications/notifications.service";
import type { AutonomyScoringService } from "./autonomy-scoring.service";
import { updateAutonomySettingsSchema } from "./dto/autonomy-review.schemas";
import { evaluateGuardrails } from "./send-guardrails";
import { OutboundService } from "./outbound.service";

/**
 * Compose time: what the loop does before anything is held.
 *
 * The order is the assertion. Every one of these tests names the spend or the
 * send it prevents rather than the method it calls, because the value of the
 * ordering is entirely in what does NOT happen — a provider that is not paid to
 * write to somebody who just replied, a message row that is not written for a
 * draft that quoted a figure, a hold that is not placed on a draft the model was
 * not confident about.
 *
 * The last describe is the one that outlives this file: `composeAndHold` must
 * not read the send-time facts. If it ever does, the guardrails are enforcing a
 * reading of the world from before the hold window, which is the failure
 * `send-guardrails.ts` calls "the whole ticket".
 */

const ORG = "org-1";
const PARTY = "party-1";

interface Recorder {
  inserts: { table: string; values: Record<string, unknown> }[];
  updates: { table: string; values: Record<string, unknown> }[];
}

const recorder = (): Recorder => ({ inserts: [], updates: [] });

/**
 * A chainable stand-in for one Drizzle statement.
 *
 * Every builder method returns the same object and the object is thenable, so
 * `.leftJoin().where().orderBy().limit()` and `.values().returning()` both
 * resolve to `rows` regardless of the order the call site happened to use.
 */
function chain(rows: unknown[]): Record<string, unknown> {
  const link: Record<string, unknown> = {
    then: (resolve: (value: unknown[]) => unknown, reject?: (error: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
  };

  for (const method of [
    "from",
    "leftJoin",
    "innerJoin",
    "where",
    "orderBy",
    "limit",
    "returning",
    "onConflictDoNothing",
    "onConflictDoUpdate",
  ])
    link[method] = () => link;

  return link;
}

interface Fixture {
  /** Null means the party is not on file. */
  party?: { name: string; companyName: string | null } | null;
  relationship?: { lastInboundAt: Date | null; lastOutboundAt: Date | null; awaitingReplySince: Date | null };
  contactEmail?: string | null;
  lastAutonomousSentAt?: Date | null;
  /** Null means the deal has no owner, so there is nobody to write as. */
  senderName?: string | null;
  /** Set to mark the party row itself soft-deleted. */
  partyDeletedAt?: Date | null;
}

/**
 * Every case here passes a deal, because the deal is what carries the sender.
 *
 * That is the loop's real shape rather than the test's convenience: without one
 * there is no salesperson to write as and `composeAndHold` refuses before it
 * pays a provider — see `loadComposeContext`'s docblock.
 */
const DEAL = "42";

function makeDb(rec: Recorder, fixture: Fixture = {}): Db {
  const party =
    fixture.party === undefined ? { name: "Priya Raman", companyName: "Acme" } : fixture.party;

  const reads = new Map<unknown, unknown[]>([
    [
      businessParties,
      party
        ? [
            {
              ...party,
              email:
                fixture.contactEmail === undefined ? "buyer@acme.example" : fixture.contactEmail,
              deletedAt: fixture.partyDeletedAt ?? null,
            },
          ]
        : [],
    ],
    [
      relationshipStates,
      [
        // Sixty days of silence on an open deal, with the ball in their court:
        // the shape `judgeOutbound` answers with a nudge.
        fixture.relationship ?? {
          lastInboundAt: null,
          lastOutboundAt: new Date(Date.now() - 60 * 86_400_000),
          awaitingReplySince: new Date(Date.now() - 60 * 86_400_000),
        },
      ],
    ],
    [crmOutboundMessages, fixture.lastAutonomousSentAt ? [{ sentAt: fixture.lastAutonomousSentAt }] : []],
    [
      deals,
      [
        {
          name: "Renewal",
          stage: "PROPOSAL",
          stageType: null,
          nextStep: null,
          notes: "We agreed to reconvene once their board had seen the outline.",
          followUpDate: null,
          senderName: fixture.senderName === undefined ? "Arun Mehta" : fixture.senderName,
          assignedToId: "user-owner",
        },
      ],
    ],
    [
      partyContacts,
      fixture.contactEmail === null ? [] : [{ email: fixture.contactEmail ?? "buyer@acme.example" }],
    ],
  ]);

  const returning = new Map<unknown, unknown[]>([
    [autonomousDecisions, [{ id: "decision-1" }]],
    [crmOutboundMessages, [{ id: "msg-1" }]],
    [autonomyHolds, [{ id: "hold-1" }]],
    [workflowRuns, [{ workflowRunId: "run-1" }]],
  ]);

  const name = (table: unknown): string => {
    if (table === autonomousDecisions) return "autonomous_decisions";
    if (table === crmOutboundMessages) return "crm_outbound_messages";
    if (table === autonomyHolds) return "autonomy_holds";
    if (table === workflowRuns) return "workflow_runs";
    return "other";
  };

  const double: Record<string, unknown> = {
    /**
     * Composing a hold runs in one tenant transaction now, because
     * `autonomy_holds` is under row-level security and the decision, the
     * message, the hold and its run have to commit together. The double runs the
     * body against itself, so what each case records is unchanged.
     */
    transaction: (body: (handle: unknown) => Promise<unknown>) => body(double),
    // `withTenant` sets the organisation GUCs through `tx.execute` before it hands
    // the transaction on; nothing here reads the result.
    execute: () => Promise.resolve([]),
    select: () => ({ from: (table: unknown) => chain(reads.get(table) ?? []) }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        rec.inserts.push({ table: name(table), values });
        return chain(returning.get(table) ?? []);
      },
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => {
        rec.updates.push({ table: name(table), values });
        return chain([]);
      },
    }),
  };

  return double as unknown as Db;
}

interface Harness {
  service: OutboundService;
  gateway: { invokeStructuredWithUsage: jest.Mock };
  rec: Recorder;
}

/** A draft the model returned, confident enough to send unless a test says otherwise. */
function drafted(over: Partial<{ subject: string; body: string; confidence: number; summary: string }> = {}) {
  return {
    ok: true as const,
    data: {
      subject: "Where things stand",
      body: "It has been a little while since we spoke and I wanted to check where things stand at your end.",
      confidence: 0.9,
      summary: "Checked in after a long silence.",
      ...over,
    },
    aiUsage: { model: "small-1" },
  };
}

function harness(fixture: Fixture = {}, gatewayResult: unknown = drafted()): Harness {
  const rec = recorder();
  const gateway = { invokeStructuredWithUsage: jest.fn().mockResolvedValue(gatewayResult) };

  const service = new OutboundService(
    makeDb(rec, fixture),
    gateway as unknown as AiGatewayService,
    { settingsFor: async () => ({ shadowSampleRate: 0, shadowDailyCap: 0, holdWindowSeconds: 60 }) } as unknown as AutonomyScoringService,
    { create: jest.fn() } as unknown as NotificationsService,
    { findSuppressed: async () => new Set<string>() } as unknown as EmailSuppressionService,
  );

  return { service, gateway, rec };
}

const insertsTo = (rec: Recorder, table: string) =>
  rec.inserts.filter((row) => row.table === table);

describe("composing an outbound message", () => {
  /**
   * The relationship is judged before a provider is paid.
   *
   * `judgeOutbound` checks every refusal before every reason to act, so a
   * customer who replied is refused even when the silence would otherwise have
   * warranted a nudge. The point of running it first is that the refusal costs
   * nothing — a loop that drafted and then discarded would bill the tenant for
   * every message it decided not to send.
   */
  it("pays no provider for a customer who has just replied", async () => {
    const h = harness({
      relationship: {
        lastInboundAt: new Date(Date.now() - 60_000),
        lastOutboundAt: new Date(Date.now() - 40 * 86_400_000),
        awaitingReplySince: null,
      },
    });

    const result = await h.service.composeAndHold({ organizationId: ORG, partyId: PARTY, dealId: DEAL });

    expect(h.gateway.invokeStructuredWithUsage).not.toHaveBeenCalled();
    expect(result).toEqual({
      held: false,
      stage: "eligibility",
      reason: "They replied after our last message — there is no silence to break.",
    });
  });

  /**
   * Recorded even so. A decision nobody wrote down is indistinguishable from a
   * loop that never ran, and the correction rate needs a denominator that
   * includes the messages there was nothing to say in.
   */
  it("records the refusal rather than returning silently", async () => {
    const h = harness({
      relationship: {
        lastInboundAt: new Date(Date.now() - 60_000),
        lastOutboundAt: new Date(Date.now() - 40 * 86_400_000),
        awaitingReplySince: null,
      },
    });

    await h.service.composeAndHold({ organizationId: ORG, partyId: PARTY, dealId: DEAL });

    expect(insertsTo(h.rec, "autonomous_decisions")).toHaveLength(1);
    expect(insertsTo(h.rec, "autonomous_decisions")[0]!.values).toEqual(
      expect.objectContaining({ kind: "outbound.sent", outcome: "skipped" }),
    );
    // Nothing was drafted, so nothing is waiting to send.
    expect(insertsTo(h.rec, "crm_outbound_messages")).toHaveLength(0);
    expect(insertsTo(h.rec, "autonomy_holds")).toHaveLength(0);
  });

  it("refuses to hold a draft that quoted a figure", async () => {
    const h = harness({}, drafted({ body: "I can do this for ₹45,000 if we sign this week — let me know." }));

    const result = await h.service.composeAndHold({ organizationId: ORG, partyId: PARTY, dealId: DEAL });

    expect(result).toEqual({
      held: false,
      stage: "draft",
      reason: "The draft quoted a figure, which a follow-up may never do. Refused.",
    });
    expect(insertsTo(h.rec, "crm_outbound_messages")).toHaveLength(0);
    expect(insertsTo(h.rec, "autonomy_holds")).toHaveLength(0);
  });

  /**
   * `decision-record.ts` puts a follow-up at 0.8 — above a task, below a quote.
   * A draft under it is recorded and dropped rather than sent tentatively: the
   * product acts or stays out of the way, and a queue of half-confident
   * suggestions is the behaviour it exists to replace.
   */
  it("drops a draft the model was not confident enough about", async () => {
    const h = harness({}, drafted({ confidence: 0.7 }));

    const result = await h.service.composeAndHold({ organizationId: ORG, partyId: PARTY, dealId: DEAL });

    expect(result).toEqual(expect.objectContaining({ held: false, stage: "confidence" }));
    expect(insertsTo(h.rec, "autonomy_holds")).toHaveLength(0);
    expect(insertsTo(h.rec, "autonomous_decisions")[0]!.values).toEqual(
      expect.objectContaining({ outcome: "skipped", confidence: 0.7 }),
    );
  });

  /**
   * The three rows, in the order they have to be written.
   *
   * The ledger first, because `crm_outbound_messages.autonomous_decision_id` is
   * NOT NULL and the ledger is the row that must exist even when everything
   * after it fails. The hold last, because the moment it exists the window has
   * started and a human may cancel it.
   */
  it("writes the ledger, then the message, then the hold", async () => {
    const h = harness();

    const result = await h.service.composeAndHold({ organizationId: ORG, partyId: PARTY, dealId: DEAL });

    expect(result).toEqual(expect.objectContaining({ held: true, outboundMessageId: "msg-1" }));
    expect(h.rec.inserts.map((row) => row.table)).toEqual([
      "autonomous_decisions",
      "crm_outbound_messages",
      "autonomy_holds",
      "workflow_runs",
    ]);
  });

  it("records the decision as held rather than applied, because it has not left", async () => {
    const h = harness();

    await h.service.composeAndHold({ organizationId: ORG, partyId: PARTY, dealId: DEAL });

    expect(insertsTo(h.rec, "autonomous_decisions")[0]!.values).toEqual(
      expect.objectContaining({ outcome: "held", reversibility: "hold" }),
    );
  });

  /**
   * The track is derived from the class by `outbound-classes.ts` and never
   * passed in. A `cold_outreach` row filed as `engaged` would slip past the cold
   * gate's own daily count, which is why the database refuses the combination as
   * well — see `chk_crm_outbound_messages_track`.
   */
  it("derives the track from the class rather than accepting one", async () => {
    const h = harness();

    await h.service.composeAndHold({ organizationId: ORG, partyId: PARTY, dealId: DEAL });

    const message = insertsTo(h.rec, "crm_outbound_messages")[0]!.values;
    expect(message.outboundClass).toBe("nudge");
    expect(message.track).toBe("engaged");
  });

  /**
   * The cold track is not entered from a relationship, and `judgeOutbound` never
   * proposes `cold_outreach` — spec-pinned in `outbound-eligibility.spec.ts`. So
   * every message this path can produce is on the engaged track, and the cold
   * gate stays dark until ticket 09 gives it its own entry point. Asserted here
   * so the day somebody wires cold into this loop, they read this first.
   */
  it("never produces a cold message from a relationship", async () => {
    for (const lastInbound of [null, new Date(Date.now() - 400 * 86_400_000)]) {
      const h = harness({
        relationship: {
          lastInboundAt: lastInbound,
          lastOutboundAt: new Date(Date.now() - 400 * 86_400_000),
          awaitingReplySince: new Date(Date.now() - 400 * 86_400_000),
        },
      });

      await h.service.composeAndHold({ organizationId: ORG, partyId: PARTY, dealId: DEAL });

      for (const insert of insertsTo(h.rec, "crm_outbound_messages"))
        expect(insert.values.track).toBe("engaged");
      for (const insert of insertsTo(h.rec, "autonomous_decisions"))
        expect(insert.values.kind).toBe("outbound.sent");
    }
  });

  /**
   * `judgeDraft` would refuse this anyway, with `no-sender-name`. Checking it
   * first is worth a duplicated condition because the difference is a provider
   * call billed on every sweep over a deal nobody owns.
   */
  it("pays no provider when nobody owns the deal to write as", async () => {
    const h = harness({ senderName: null });

    const result = await h.service.composeAndHold({
      organizationId: ORG,
      partyId: PARTY,
      dealId: DEAL,
    });

    expect(h.gateway.invokeStructuredWithUsage).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ held: false, stage: "draft" }));
    expect(insertsTo(h.rec, "autonomy_holds")).toHaveLength(0);
  });

  it("does not draft to somebody with no address on file", async () => {
    const h = harness({ contactEmail: null, party: { name: "Priya Raman", companyName: null } });

    const result = await h.service.composeAndHold({ organizationId: ORG, partyId: PARTY, dealId: DEAL });

    expect(h.gateway.invokeStructuredWithUsage).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({ held: false, stage: "eligibility" }),
    );
  });
});

/**
 * The seam this whole ticket turns on, asserted from the compose side.
 *
 * `send-guardrails.ts` says the snapshot belongs inside the step that claims the
 * send. `outbound.workflow.spec.ts` proves it is taken there; this proves it is
 * not ALSO taken here — because a compose-time snapshot would be the value a
 * later refactor reached for, and the guardrails would silently start enforcing
 * an hour-old reading of the world.
 */
describe("compose time does not look at the send-time world", () => {
  it("takes no guardrail snapshot while drafting and holding", async () => {
    const h = harness();
    const facts = jest.spyOn(h.service, "sendTimeFacts");
    const cold = jest.spyOn(h.service, "coldTrackFacts");

    await h.service.composeAndHold({ organizationId: ORG, partyId: PARTY, dealId: DEAL });

    expect(facts).not.toHaveBeenCalled();
    expect(cold).not.toHaveBeenCalled();
  });
});

/**
 * A party can be soft-deleted while a message sits in its hold window, and
 * `sendTimeFacts` is the read that has to notice — `evaluateGuardrails` only
 * knows what this function tells it. Exercised through `sendTimeFacts` itself
 * rather than only through the pure guardrail, so a regression that stops
 * populating `partyDeleted` from `business_parties.deleted_at` fails here even
 * though `send-guardrails.spec.ts`'s pure-function tests would stay green.
 */
describe("sendTimeFacts and a deleted party", () => {
  /**
   * A Wednesday, 11:30 in `FALLBACK_TIMEZONE` (Asia/Kolkata) — inside
   * `OUTBOUND_WORKING_HOURS` — pinned so the "live party" case below asserts
   * `allow: true` on the fact that matters (`partyDeleted`) rather than on
   * whatever hour it happens to be wherever this suite runs. `sendTimeFacts`
   * reads `now` with `new Date()` internally and takes no clock argument, so
   * fake timers are the only way to hold it still.
   */
  const IN_HOURS = new Date("2026-08-26T06:00:00.000Z");

  beforeEach(() => jest.useFakeTimers({ now: IN_HOURS }));
  afterEach(() => jest.useRealTimers());

  function message(over: Partial<Parameters<OutboundService["sendTimeFacts"]>[1]> = {}) {
    return {
      outboundMessageId: "msg-1",
      partyId: PARTY,
      contactId: null,
      dealId: null,
      outboundClass: "follow_up" as const,
      draftedAt: new Date(IN_HOURS.getTime() - 3_600_000),
      workingHourDeferrals: 0,
      recipientEmail: null,
      ...over,
    };
  }

  it("marks the party deleted, and blocks the send, once business_parties.deleted_at is set", async () => {
    const h = harness({ partyDeletedAt: new Date("2026-08-20T00:00:00.000Z") });

    const facts = await h.service.sendTimeFacts(ORG, message());

    expect(facts.partyDeleted).toBe(true);
    expect(evaluateGuardrails(facts)).toEqual({
      allow: false,
      action: "block",
      reason: "party-deleted",
    });
  });

  it("does not mark a live party deleted", async () => {
    const h = harness({ partyDeletedAt: null });

    const facts = await h.service.sendTimeFacts(ORG, message());

    expect(facts.partyDeleted).toBe(false);
    expect(evaluateGuardrails(facts).allow).toBe(true);
  });

  it("treats a party missing from business_parties entirely as deleted", async () => {
    const h = harness({ party: null });

    const facts = await h.service.sendTimeFacts(ORG, message());

    expect(facts.partyDeleted).toBe(true);
  });
});

/**
 * Guardrails are enforcement, not configuration — and adding a service is
 * exactly the moment somebody would introduce the override "just for one
 * customer". `send-guardrails.spec.ts` and `cold-outbound-gate.spec.ts` already
 * pin this for their own constants; this pins it for the surface this ticket
 * added, so the settings schema and the outbound path stay a unit.
 */
describe("none of the outbound rules are settings a tenant can override", () => {
  it("rejects every key that would reach a threshold through the settings patch", () => {
    const attempts = [
      { outboundSpacingDays: 1 },
      { frequencyCapPerParty: 99 },
      { maxWorkingHourDeferrals: 10 },
      { outboundConfidenceThreshold: 0.1 },
      { coldDailyCap: 5000 },
      { coldBounceRateCeiling: 0.5 },
      { coldOutboundEnabled: true },
      { requireConsent: false },
    ];

    for (const attempt of attempts)
      expect(updateAutonomySettingsSchema.safeParse(attempt).success).toBe(false);
  });

  it("still accepts the three dials that ARE a tenant's to set", () => {
    expect(
      updateAutonomySettingsSchema.safeParse({
        shadowSampleRate: 0.2,
        shadowDailyCap: 100,
        holdWindowSeconds: 120,
      }).success,
    ).toBe(true);
  });
});
