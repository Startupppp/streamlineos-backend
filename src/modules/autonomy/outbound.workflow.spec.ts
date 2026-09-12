/**
 * The end of an outbound hold, driven through the real step machinery.
 *
 * Three things here are not ordinary scaffolding and are the point of the file.
 *
 * `tenantDepth` mirrors what the runner actually gives a workflow — every
 * `step.run` body is wrapped in a tenant transaction and the handler body is NOT
 * — so a query issued outside one is recorded as a violation rather than passing
 * silently the way it does against a database owner with BYPASSRLS.
 *
 * `events` records step commits, the fact-snapshot, and the mail leaving in ONE
 * ordered list. That list is the only way to state the two properties this
 * ticket turns on: the claim was durable before the message left, and the
 * guardrail snapshot was taken after the window rather than when the draft was
 * written.
 *
 * And the run is driven TWICE against one store — suspending on the sleep and
 * resuming afterwards — because a snapshot taken at compose time, or anywhere in
 * the handler body before `step.sleep`, would be taken on the FIRST pass. The
 * first-pass assertions below fail if it moves, which is what makes
 * `send-guardrails.ts`'s "not at compose time, and the distinction is the whole
 * ticket" a test rather than a comment.
 */

let tenantDepth = 0;

async function withTenantDepth<T>(fn: () => Promise<T>): Promise<T> {
  tenantDepth += 1;
  try {
    return await fn();
  } finally {
    tenantDepth -= 1;
  }
}

jest.mock("../../common/tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: <T,>(_db: unknown, _orgId: string, fn: () => Promise<T>) =>
    withTenantDepth(fn),
}));

import { createStepContext } from "../../common/workflow/step-context";
import type { RecordedStep, WorkflowStepStore } from "../../common/workflow/workflow.types";
import { isSuspension, WorkflowRegistry } from "../../common/workflow";
import type { Db } from "../../db/drizzle.types";
import { autonomousDecisions, autonomyHolds, crmOutboundMessages } from "../../db/schema";
import type { EmailOutboxService } from "../email/email-outbox.service";
import type { OutboundClass } from "./outbound-classes";
import type { SendTimeFacts } from "./send-guardrails";
import type { ColdTrackFacts } from "./cold-outbound-gate";
import { OUTBOUND_WORKFLOW, type OutboundService } from "./outbound.service";
import { OutboundWorkflow } from "./outbound.workflow";

const ORG = "org-1";
const HOLD = "hold-1";
const MESSAGE = "msg-1";
const DECISION = "decision-1";
const PARTY = "party-1";
const ADDRESS = "buyer@acme.example";

/** A window that closed a minute ago, unless a test says otherwise. */
const closed = () => new Date(Date.now() - 60_000);
/** A window that has a minute left to run. */
const future = () => new Date(Date.now() + 60_000);

/** Nine in the morning on a Wednesday in the tenant's zone: inside working hours. */
const OPEN_HOURS = new Date("2026-03-04T09:30:00+05:30");

interface Recorder {
  events: string[];
  holdUpdates: Record<string, unknown>[];
  messageUpdates: Record<string, unknown>[];
  decisionUpdates: Record<string, unknown>[];
  /** Tables read with no tenant transaction around them. Must stay empty. */
  unscopedReads: string[];
}

const recorder = (): Recorder => ({
  events: [],
  holdUpdates: [],
  messageUpdates: [],
  decisionUpdates: [],
  unscopedReads: [],
});

function query<T>(rows: T[]) {
  return {
    then: (resolve: (value: T[]) => unknown, reject?: (error: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
    limit: async () => rows,
    returning: async () => rows,
  };
}

interface HoldFixture {
  status: "held" | "sent" | "cancelled" | "failed";
  holdUntil: Date;
  outboundClass?: OutboundClass;
  workingHourDeferrals?: number;
}

function makeDb(rec: Recorder, hold: HoldFixture | null, claimWins = true): Db {
  const holdRows = hold
    ? [
        {
          status: hold.status,
          holdUntil: hold.holdUntil,
          decisionId: DECISION,
          outboundMessageId: MESSAGE,
          partyId: PARTY,
          contactId: 7,
          dealId: "42",
          outboundClass: hold.outboundClass ?? "follow_up",
          subject: "Following up",
          body: "Just checking where things stand after our call.",
          draftedAt: new Date(Date.now() - 3_600_000),
          workingHourDeferrals: hold.workingHourDeferrals ?? 0,
        },
      ]
    : [];

  return {
    select: () => ({
      from: () => {
        if (tenantDepth === 0) rec.unscopedReads.push("autonomy_holds");
        return {
          leftJoin: () => ({ where: () => query(holdRows) }),
          where: () => query(holdRows),
        };
      },
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => {
        if (table === autonomyHolds) rec.holdUpdates.push(values);
        if (table === crmOutboundMessages) rec.messageUpdates.push(values);
        if (table === autonomousDecisions) rec.decisionUpdates.push(values);
        return {
          where: () =>
            query(
              table === autonomyHolds && values.status === "sent" && !claimWins
                ? []
                : [{ id: HOLD }],
            ),
        };
      },
    }),
  } as unknown as Db;
}

function memoryStore(initial: RecordedStep[] = [], rec?: Recorder) {
  const rows = [...initial];
  const store: WorkflowStepStore = {
    loadSteps: async () => rows,
    recordStep: async (step) => {
      if (rec && step.status === "COMPLETED") rec.events.push(`commit:${step.stepName}`);
      const at = rows.findIndex((row) => row.stepName === step.stepName);
      const row: RecordedStep = {
        stepName: step.stepName,
        status: step.status,
        output: step.output,
      };
      if (at >= 0) rows[at] = row;
      else rows.push(row);
    },
  };
  return Object.assign(store, { rows });
}

/** Facts that allow the send, unless a test overrides one of them. */
function allowingFacts(over: Partial<SendTimeFacts> = {}): SendTimeFacts {
  return {
    now: OPEN_HOURS,
    outboundClass: "follow_up",
    partyDeleted: false,
    consent: "UNKNOWN",
    consentExpiresAt: null,
    suppressed: false,
    classStopped: false,
    recentSendsToParty: [],
    partyTimezone: null,
    tenantTimezone: "Asia/Kolkata",
    repliedAt: null,
    draftedAt: new Date(OPEN_HOURS.getTime() - 3_600_000),
    dealState: "open",
    deferralsSoFar: 0,
    ...over,
  };
}

/** A cold track that would allow the send: enabled, verified, warm, quiet. */
function allowingCold(over: Partial<ColdTrackFacts> = {}): ColdTrackFacts {
  return {
    now: OPEN_HOURS,
    enabled: true,
    pausedAt: null,
    domain: {
      domain: "acme-outreach.example",
      purpose: "cold",
      verifiedAt: new Date(OPEN_HOURS.getTime() - 30 * 86_400_000),
      warmupStartedAt: new Date(OPEN_HOURS.getTime() - 30 * 86_400_000),
    },
    transactionalDomain: "acme.example",
    sentToday: 0,
    recentSends: 0,
    recentBounces: 0,
    recentComplaints: 0,
    ...over,
  };
}

interface Harness {
  workflow: OutboundWorkflow;
  registry: WorkflowRegistry;
  outbound: {
    switchAllows: jest.Mock;
    resolveRecipient: jest.Mock;
    sendTimeFacts: jest.Mock;
    coldTrackFacts: jest.Mock;
    pauseColdTrack: jest.Mock;
  };
  send: jest.Mock;
}

function harness(
  rec: Recorder,
  db: Db,
  options: {
    facts?: SendTimeFacts;
    cold?: ColdTrackFacts;
    recipient?: string | null;
    switchAllows?: boolean;
    send?: jest.Mock;
  } = {},
): Harness {
  const outbound = {
    switchAllows: jest.fn().mockResolvedValue(options.switchAllows ?? true),
    resolveRecipient: jest.fn().mockImplementation(async () => {
      rec.events.push("resolve-recipient");
      return options.recipient === undefined ? ADDRESS : options.recipient;
    }),
    sendTimeFacts: jest.fn().mockImplementation(async () => {
      rec.events.push("send-time-facts");
      return options.facts ?? allowingFacts();
    }),
    coldTrackFacts: jest.fn().mockImplementation(async () => {
      rec.events.push("cold-track-facts");
      return options.cold ?? allowingCold();
    }),
    pauseColdTrack: jest.fn().mockImplementation(async () => {
      rec.events.push("pause-cold-track");
    }),
  };

  const send =
    options.send ??
    jest.fn().mockImplementation(async () => {
      rec.events.push("send");
    });

  const registry = new WorkflowRegistry();
  const workflow = new OutboundWorkflow(
    db,
    registry,
    outbound as unknown as OutboundService,
    { enqueueAndTry: send } as unknown as EmailOutboxService,
  );
  workflow.onModuleInit();

  return { workflow, registry, outbound, send };
}

/** One attempt at the run. Returns whether it suspended on a sleep. */
async function attempt(
  h: Harness,
  store: ReturnType<typeof memoryStore>,
): Promise<{ suspended: boolean }> {
  const definition = h.registry.get(OUTBOUND_WORKFLOW);
  if (!definition) throw new Error("workflow was not registered");

  const step = await createStepContext({
    runId: "run-1",
    organizationId: ORG,
    attempt: 0,
    store,
    // Exactly what the runner does: a step body gets a tenant transaction, and
    // nothing else in the handler does.
    withinStep: (_name, fn) => withTenantDepth(fn),
  });

  try {
    await definition.handler(step, {
      runId: "run-1",
      organizationId: ORG,
      attempt: 0,
      input: { autonomyHoldId: HOLD, outboundMessageId: MESSAGE },
    });
    return { suspended: false };
  } catch (error) {
    if (isSuspension(error)) return { suspended: true };
    throw error;
  }
}

beforeEach(() => {
  tenantDepth = 0;
});

describe("the outbound workflow", () => {
  it("registers itself, so a run is not dead-lettered for want of a handler", () => {
    const rec = recorder();
    const h = harness(rec, makeDb(rec, { status: "held", holdUntil: closed() }));
    expect(h.registry.names).toContain(OUTBOUND_WORKFLOW);
  });

  /**
   * The first read happens before the first step, so it has no tenant
   * transaction unless it opens one. Both `autonomy_holds` and
   * `crm_outbound_messages` have NOT NULL tenant columns, so their policies call
   * the raising `app.current_org_id()` — a context-less read is 42501, five
   * retries, and a dead-lettered run whose message never sends. Invisible in
   * dev, where the connection owns the database.
   */
  it("never reads outside a tenant transaction", async () => {
    const rec = recorder();
    const store = memoryStore([], rec);

    await attempt(harness(rec, makeDb(rec, { status: "held", holdUntil: future() })), store);
    await attempt(harness(rec, makeDb(rec, { status: "held", holdUntil: closed() })), store);

    expect(rec.unscopedReads).toEqual([]);
  });

  /**
   * THE ORDER, stated as one list.
   *
   * `send-guardrails.ts` opens by saying the snapshot belongs at send time and
   * that "the distinction is the whole ticket". This is that distinction as an
   * assertion: nothing looks at the world on the pass that starts the wait, and
   * the pass that ends it reads the facts, commits the claim, and only then puts
   * the mail on the wire.
   */
  describe("the guardrail snapshot is taken at send time, not compose time", () => {
    it("reads no facts at all on the pass that starts the wait", async () => {
      const rec = recorder();
      const db = makeDb(rec, { status: "held", holdUntil: future() });
      const store = memoryStore([], rec);
      const h = harness(rec, db);

      const { suspended } = await attempt(h, store);

      expect(suspended).toBe(true);
      // The sleep is the only thing that happened. A snapshot taken in the
      // handler body — or carried in from `composeAndHold` — would appear here.
      expect(rec.events).toEqual(["commit:hold-window"]);
      expect(h.outbound.sendTimeFacts).not.toHaveBeenCalled();
      expect(h.outbound.resolveRecipient).not.toHaveBeenCalled();
      expect(h.send).not.toHaveBeenCalled();
    });

    it("reads them on the pass that ends it, before the claim commits", async () => {
      const rec = recorder();
      const store = memoryStore([], rec);

      // Pass one starts the wait.
      const open = harness(rec, makeDb(rec, { status: "held", holdUntil: future() }));
      await attempt(open, store);

      // Pass two is the runtime re-claiming the same run once the window has
      // closed — a different process, the same recorded steps.
      const due = harness(rec, makeDb(rec, { status: "held", holdUntil: closed() }));
      await attempt(due, store);

      expect(rec.events).toEqual([
        "commit:hold-window",
        "resolve-recipient",
        "send-time-facts",
        "commit:claim-send-0",
        "send",
        "commit:perform-send",
      ]);
    });

    /**
     * The semantic half of the same property, and the one a reader recognises.
     *
     * At compose time the relationship was silent and the draft was right. They
     * answered while it waited. A guardrail evaluated against the compose-time
     * world would send a follow-up to somebody who had just replied — which is
     * the case `send-guardrails.ts` calls out as the one that makes send-time
     * evaluation load-bearing rather than tidy.
     */
    it("blocks a message the customer answered while it was waiting", async () => {
      const rec = recorder();
      const drafted = new Date(OPEN_HOURS.getTime() - 3_600_000);
      const db = makeDb(rec, { status: "held", holdUntil: closed() });
      const h = harness(rec, db, {
        facts: allowingFacts({
          draftedAt: drafted,
          repliedAt: new Date(drafted.getTime() + 1_000),
        }),
      });

      await attempt(h, memoryStore([sleptStep()], rec));

      expect(h.send).not.toHaveBeenCalled();
      expect(rec.messageUpdates).toEqual([
        { status: "blocked", blockedReason: "reply-arrived" },
      ]);
      expect(rec.decisionUpdates).toEqual([
        {
          outcome: "skipped",
          summary: "They replied while it was waiting, so it was no longer the right message.",
        },
      ]);
    });
  });

  /**
   * The claim and the send are two transactions, or "sends at most once" is not
   * true. In one step, a pod killed — or an idle-in-transaction timeout fired —
   * between the mail leaving and COMMIT rolls the claim back to `held`, the lease
   * expires, the run is re-claimed, and the customer gets it twice.
   */
  it("commits the held→sent claim before the message leaves", async () => {
    const rec = recorder();
    const db = makeDb(rec, { status: "held", holdUntil: closed() });
    const h = harness(rec, db);

    await attempt(h, memoryStore([sleptStep()], rec));

    expect(rec.events.indexOf("commit:claim-send-0")).toBeLessThan(rec.events.indexOf("send"));
    expect(rec.decisionUpdates).toEqual([{ outcome: "applied" }]);
    expect(rec.messageUpdates).toContainEqual(
      expect.objectContaining({ status: "sent", recipientEmail: ADDRESS }),
    );
  });

  it("does not claim a second time when only the send is retried", async () => {
    const rec = recorder();
    const db = makeDb(rec, { status: "sent", holdUntil: closed() });
    const h = harness(rec, db);

    const store = memoryStore(
      [
        sleptStep(),
        {
          stepName: "claim-send-0",
          status: "COMPLETED",
          output: {
            outcome: "claimed",
            waitMs: 0,
            outboundMessageId: MESSAGE,
            decisionId: DECISION,
            recipientEmail: ADDRESS,
            subject: "Following up",
            body: "Just checking where things stand after our call.",
          },
        },
      ],
      rec,
    );

    await attempt(h, store);

    expect(h.send).toHaveBeenCalledTimes(1);
    // Nothing moved the hold again: the memo answered for the claim.
    expect(rec.holdUpdates).toEqual([]);
    expect(h.outbound.sendTimeFacts).not.toHaveBeenCalled();
  });

  /**
   * A message put off for the clock waits and comes back, and the count that
   * bounds how often that may happen rises at the moment it is deferred rather
   * than when the run next wakes — a run that never wakes would otherwise leave
   * a week-old message presenting itself as fresh.
   */
  describe("outside working hours", () => {
    /** Two in the morning on a Sunday in the tenant's zone. */
    const ASLEEP = new Date("2026-03-01T02:00:00+05:30");

    it("sleeps until the window opens instead of sending, and counts the deferral", async () => {
      const rec = recorder();
      const db = makeDb(rec, { status: "held", holdUntil: closed() });
      const h = harness(rec, db, {
        facts: allowingFacts({ now: ASLEEP, draftedAt: new Date(ASLEEP.getTime() - 3_600_000) }),
      });

      const { suspended } = await attempt(h, memoryStore([sleptStep()], rec));

      expect(suspended).toBe(true);
      expect(h.send).not.toHaveBeenCalled();
      expect(rec.messageUpdates).toEqual([
        {
          workingHourDeferrals: 1,
          timezoneUsed: "Asia/Kolkata",
          timezoneSource: "tenant",
        },
      ]);
      // The claim step commits its deferral BEFORE the second sleep, and that
      // sleep runs under its own name -- reusing "hold-window" would collide with
      // the memo of the first and `createStepContext` would throw.
      expect(rec.events).toEqual([
        "resolve-recipient",
        "send-time-facts",
        "commit:claim-send-0",
        "commit:defer-0",
      ]);
    });

    /**
     * `MAX_WORKING_HOUR_DEFERRALS` is the rule and the loop is not allowed to
     * outlive it. A message already put off twice is stale enough that sending
     * it is worse than not — the follow-up nobody sent for nine days is a
     * different message from the one that was drafted.
     */
    it("drops a message that has already waited out the maximum", async () => {
      const rec = recorder();
      const db = makeDb(rec, { status: "held", holdUntil: closed(), workingHourDeferrals: 2 });
      const h = harness(rec, db, {
        facts: allowingFacts({
          now: ASLEEP,
          draftedAt: new Date(ASLEEP.getTime() - 3_600_000),
          deferralsSoFar: 2,
        }),
      });

      await attempt(h, memoryStore([sleptStep()], rec));

      expect(h.send).not.toHaveBeenCalled();
      expect(rec.messageUpdates).toEqual([
        { status: "blocked", blockedReason: "deferred-too-often" },
      ]);
    });
  });

  /**
   * The kill switch is re-read on wake, not only at placement — an operator who
   * stops outbound at noon stops a message decided at nine.
   */
  it("cancels rather than sends when the switch went off during the hold", async () => {
    const rec = recorder();
    const db = makeDb(rec, { status: "held", holdUntil: closed() });
    const h = harness(rec, db, { switchAllows: false });

    await attempt(h, memoryStore([sleptStep()], rec));

    expect(h.send).not.toHaveBeenCalled();
    // Not even looked at: a switched-off send has nothing to snapshot.
    expect(h.outbound.sendTimeFacts).not.toHaveBeenCalled();
    expect(rec.messageUpdates).toEqual([
      { status: "cancelled", blockedReason: "switched-off" },
    ]);
    expect(rec.decisionUpdates[0]).toEqual(
      expect.objectContaining({ outcome: "reversed" }),
    );
  });

  /**
   * The address is resolved at send time because a contact may have changed it
   * during the window. When there is none left, that is a failure rather than a
   * guardrail block: `GuardrailBlock` has no member for it, and recording it as
   * one of the others would put a reason in the ledger that did not happen.
   */
  it("fails rather than sends when there is no address left to send to", async () => {
    const rec = recorder();
    const db = makeDb(rec, { status: "held", holdUntil: closed() });
    const h = harness(rec, db, { recipient: null });

    await attempt(h, memoryStore([sleptStep()], rec));

    expect(h.send).not.toHaveBeenCalled();
    expect(h.outbound.sendTimeFacts).not.toHaveBeenCalled();
    expect(rec.messageUpdates).toEqual([
      { status: "failed", blockedReason: "no-reachable-address" },
    ]);
  });

  it("records a send the provider refused as failed, not as applied", async () => {
    const rec = recorder();
    const db = makeDb(rec, { status: "held", holdUntil: closed() });
    const h = harness(rec, db, {
      send: jest.fn().mockRejectedValue(new Error("No email provider configured")),
    });

    await attempt(h, memoryStore([sleptStep()], rec));

    expect(rec.decisionUpdates).toEqual([{ outcome: "failed" }]);
    expect(rec.messageUpdates).toContainEqual({ status: "failed", blockedReason: "send-failed" });
    // Failed, never back to `held`: a hold that resumed waiting would send on
    // the next attempt with no window at all.
    expect(rec.holdUpdates).toContainEqual({ status: "failed", sentAt: null });
  });

  // ── The cold track ────────────────────────────────────────────────────────

  describe("the cold gate", () => {
    it("is not consulted for a message on the engaged track", async () => {
      const rec = recorder();
      const db = makeDb(rec, { status: "held", holdUntil: closed(), outboundClass: "nudge" });
      const h = harness(rec, db, { facts: allowingFacts({ outboundClass: "nudge" }) });

      await attempt(h, memoryStore([sleptStep()], rec));

      expect(h.outbound.coldTrackFacts).not.toHaveBeenCalled();
      expect(h.send).toHaveBeenCalledTimes(1);
    });

    /**
     * After the guardrails, never before. The guardrails are about the
     * recipient's rights; the gate is about a sending domain's reputation. A
     * message going to somebody who opted out must be reported as the opt-out
     * even when the domain would also have refused it, because the ledger entry
     * is what a person reads to find out what the system decided.
     */
    it("runs after the guardrails, so an opt-out is reported as the opt-out", async () => {
      const rec = recorder();
      const db = makeDb(rec, {
        status: "held",
        holdUntil: closed(),
        outboundClass: "cold_outreach",
      });
      const h = harness(rec, db, {
        facts: allowingFacts({ outboundClass: "cold_outreach", consent: "OPTED_OUT" }),
        cold: allowingCold({ enabled: false }),
      });

      await attempt(h, memoryStore([sleptStep()], rec));

      expect(h.outbound.coldTrackFacts).not.toHaveBeenCalled();
      expect(rec.messageUpdates).toEqual([{ status: "blocked", blockedReason: "opted-out" }]);
    });

    it("blocks a cold message the guardrails would have allowed", async () => {
      const rec = recorder();
      const db = makeDb(rec, {
        status: "held",
        holdUntil: closed(),
        outboundClass: "cold_outreach",
      });
      const h = harness(rec, db, {
        facts: allowingFacts({ outboundClass: "cold_outreach" }),
        // The default for a tenant that has never configured the track, and the
        // reason `evaluateColdGate` checks enablement before anything else.
        cold: allowingCold({ enabled: false }),
      });

      await attempt(h, memoryStore([sleptStep()], rec));

      expect(h.send).not.toHaveBeenCalled();
      expect(rec.messageUpdates).toEqual([{ status: "blocked", blockedReason: "not-enabled" }]);
    });

    /**
     * `pauseTrack` is returned for exactly two reasons — a bounce rate and a
     * complaint rate — and it is the signal that stops every subsequent cold
     * send, not just this one. A gate that refused the message and left the
     * track running would go on burning the domain one message at a time.
     */
    it("pauses the whole track when the domain is burning, not just this message", async () => {
      const rec = recorder();
      const db = makeDb(rec, {
        status: "held",
        holdUntil: closed(),
        outboundClass: "cold_outreach",
      });
      const h = harness(rec, db, {
        facts: allowingFacts({ outboundClass: "cold_outreach" }),
        cold: allowingCold({ recentSends: 500, recentBounces: 40 }),
      });

      await attempt(h, memoryStore([sleptStep()], rec));

      expect(h.outbound.pauseColdTrack).toHaveBeenCalledWith(ORG, "bounce-rate");
      expect(rec.messageUpdates).toEqual([{ status: "blocked", blockedReason: "bounce-rate" }]);
    });
  });
});

/** The window is already slept, which is the state most cases above start in. */
function sleptStep(): RecordedStep {
  return {
    stepName: "hold-window",
    status: "COMPLETED",
    output: { wakeAt: new Date().toISOString() },
  };
}
