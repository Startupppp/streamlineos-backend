import type { Db } from "../../db/drizzle.types";
import type { DealsService } from "../deals/deals.service";
import type { OutboundService } from "../autonomy/outbound.service";
import { LifecycleTriggersService } from "./lifecycle-triggers.service";

/**
 * What this layer is responsible for is TRAFFIC and one hand-off. The judgement
 * lives in `renewal-triggers.spec.ts`; repeating it against a scripted database
 * would only assert that the script returns what it was scripted to.
 *
 * So these tests hold the four things only this layer can get wrong, and every
 * one of them is a way the ticket could have been built as a parallel retention
 * machine without anybody noticing:
 *
 *  - the outbound loop is the ONLY thing that can produce a message, and it is
 *    handed the renewal opportunity rather than the won deal that started the
 *    contract (which `judgeOutbound` refuses outright);
 *  - the term is CLAIMED before the opportunity is opened, so two sweeps racing
 *    cannot put one customer in the pipeline twice;
 *  - a refusal is written down with the loop's own sentence, because a renewal
 *    that went unwritten and left no reason is indistinguishable from a sweep
 *    that never ran;
 *  - the contract value reaches the opportunity as the exact integer it is
 *    stored as.
 */

interface Call {
  readonly method: string;
  readonly args: readonly unknown[];
}

/** See `lifecycle.service.spec.ts`: a thenable Drizzle chain that records itself. */
function chain(result: unknown[], log: Call[]): unknown {
  const proxy: unknown = new Proxy(
    {},
    {
      get(_target, property) {
        if (property === "then")
          return (resolve: (value: unknown[]) => void) => resolve(result);
        if (typeof property === "symbol") return undefined;
        return (...args: unknown[]) => {
          log.push({ method: String(property), args });
          return proxy;
        };
      },
    },
  );
  return proxy;
}

class FakeDb {
  readonly calls: Call[] = [];
  private readonly scripted: Record<string, unknown[][]> = { select: [], insert: [], update: [] };

  script(method: "select" | "insert" | "update", ...results: unknown[][]): this {
    this.scripted[method]!.push(...results);
    return this;
  }

  private next(method: string, args: unknown[]): unknown[] {
    this.calls.push({ method, args });
    return this.scripted[method]!.shift() ?? [];
  }

  select(...args: unknown[]) {
    return chain(this.next("select", args), this.calls);
  }
  insert(...args: unknown[]) {
    return chain(this.next("insert", args), this.calls);
  }
  update(...args: unknown[]) {
    return chain(this.next("update", args), this.calls);
  }

  /** Every `.set(...)` payload, in the order the service wrote them. */
  setPayloads(): Record<string, unknown>[] {
    return this.calls
      .filter((call) => call.method === "set")
      .map((call) => call.args[0] as Record<string, unknown>);
  }

  valuePayloads(): Record<string, unknown>[] {
    return this.calls
      .filter((call) => call.method === "values")
      .map((call) => call.args[0] as Record<string, unknown>);
  }

  asDb(): Db {
    return this as unknown as Db;
  }
}

const ORG = "org_1";
const PARTY = "party_1";
const OWNER = "user_owner";
const AS_OF = new Date("2026-08-27T09:00:00.000Z");

/** Due on the calendar: the renewal is a month away, well inside the window. */
const DUE_CANDIDATE = {
  customerLifecycleId: "lc_1",
  partyId: PARTY,
  status: "active",
  startedOn: "2025-09-30",
  renewalOn: "2026-09-30",
  riskScore: 10,
  lastSignalAt: null,
  contractValueMinor: 1_234_567,
  healthScore: 71,
  healthStatus: "healthy",
  partyName: "Northwind Trading",
  companyName: "Northwind Trading Ltd",
  ownerUserId: OWNER,
  triggerId: null,
  triggerKind: null,
  dueOn: null,
  opportunityDealId: null,
  attempts: null,
  lastAttemptAt: null,
  autonomyHoldId: null,
};

const STAGE_ROW = [{ key: "QUALIFIED", pipelineId: "pipe_1" }];
const CLAIM_ROW = [{ id: "trg_1" }];

const HELD = {
  held: true as const,
  outboundMessageId: "msg_1",
  autonomyHoldId: "hold_1",
  decisionId: "dec_1",
  outboundClass: "follow_up" as const,
  holdUntil: new Date("2026-08-27T10:00:00.000Z"),
  windowSeconds: 3600,
};

function build(opts: {
  candidates?: unknown[];
  claim?: unknown[];
  compose?: unknown;
  composeThrows?: Error;
  createDeal?: unknown;
  createThrows?: Error;
}) {
  const db = new FakeDb();
  db.script("select", opts.candidates ?? [DUE_CANDIDATE]);
  db.script("insert", opts.claim ?? CLAIM_ROW);
  db.script("select", STAGE_ROW);

  /**
   * Both collaborators log into the SAME array the fake database does, so the
   * order of "claim the term", "open the opportunity" and "ask the loop" is a
   * single sequence a test can read rather than three clocks to correlate.
   */
  const composeAndHold = jest.fn(async () => {
    db.calls.push({ method: "composeAndHold", args: [] });
    if (opts.composeThrows) throw opts.composeThrows;
    return opts.compose ?? HELD;
  });
  const createDeal = jest.fn(async () => {
    db.calls.push({ method: "createDeal", args: [] });
    if (opts.createThrows) throw opts.createThrows;
    return opts.createDeal ?? { id: 4242 };
  });

  const service = new LifecycleTriggersService(
    db.asDb(),
    { createDeal } as unknown as DealsService,
    { composeAndHold } as unknown as OutboundService,
  );

  return { db, service, composeAndHold, createDeal };
}

describe("a renewal that is due", () => {
  it("offers the opportunity it opened to composeAndHold, and nothing else", async () => {
    const { service, composeAndHold, createDeal } = build({});

    const report = await service.sweep(ORG, { limit: 50, asOf: AS_OF });

    expect(createDeal).toHaveBeenCalledTimes(1);
    expect(composeAndHold).toHaveBeenCalledTimes(1);
    expect(composeAndHold).toHaveBeenCalledWith({
      organizationId: ORG,
      partyId: PARTY,
      // The opportunity's id, as a string — `loadDeal` parses it back to a
      // number. Never `startedOn`'s source deal, which is won and refused.
      dealId: "4242",
    });
    expect(report).toMatchObject({ considered: 1, opened: 1, held: 1 });
  });

  it("claims the term before it opens the opportunity, and asks the loop last", async () => {
    /**
     * The order is the whole protection against a cron and a person pressing the
     * button at the same moment. With the deal first, the sweep that loses
     * `uniq_customer_lifecycle_triggers_term` has already put a duplicate
     * renewal in the tenant's pipeline and has nothing to roll it back with.
     */
    const { db, service } = build({});

    await service.sweep(ORG, { limit: 50, asOf: AS_OF });

    const order = db.calls
      .filter((call) => ["insert", "createDeal", "composeAndHold"].includes(call.method))
      .map((call) => call.method);

    expect(order).toEqual(["insert", "createDeal", "composeAndHold"]);
  });

  it("writes the exact contract value onto the opportunity", async () => {
    /**
     * `createDeal` takes major units and multiplies them back, which is a float
     * round trip on a number that is summed across a book. The integer is
     * restored in the same breath, so nothing ever reads the rounded one.
     */
    const { db, service } = build({});

    await service.sweep(ORG, { limit: 50, asOf: AS_OF });

    const dealUpdate = db.setPayloads().find((payload) => "valueMinor" in payload);
    expect(dealUpdate?.valueMinor).toBe(1_234_567);
    expect(Number.isInteger(dealUpdate?.valueMinor)).toBe(true);
  });

  it("dates the opportunity's next step to when the conversation became due", async () => {
    // 2026-09-30 minus the 90-day lead window. Written as `follow_up_date`,
    // which is what `loadComposeContext` reads as `nextStepDueAt` — the only
    // reason the loop has anything to say about a renewal at all.
    const { db, service } = build({});

    await service.sweep(ORG, { limit: 50, asOf: AS_OF });

    const dealUpdate = db.setPayloads().find((payload) => "followUpDate" in payload);
    expect((dealUpdate?.followUpDate as Date).toISOString()).toBe("2026-07-02T00:00:00.000Z");
    expect(String(dealUpdate?.nextStep)).toContain("2026-09-30");
  });

  it("records the hold it produced and states no refusal", async () => {
    // The row-level twin of `chk_customer_lifecycle_triggers_evidence`: a held
    // trigger that also carried a refusal reason would be a renewal the log
    // claims is being worked and simultaneously explains away.
    const { db, service } = build({});

    await service.sweep(ORG, { limit: 50, asOf: AS_OF });

    const outcome = db.setPayloads().find((payload) => payload.outcome === "held");
    expect(outcome).toMatchObject({
      outcome: "held",
      refusalStage: null,
      refusalReason: null,
      autonomyHoldId: "hold_1",
      autonomousDecisionId: "dec_1",
      outboundMessageId: "msg_1",
    });
  });
});

describe("when the loop declines", () => {
  it("stores the loop's own sentence rather than a paraphrase of it", async () => {
    /**
     * The trigger log's only job is to say why a renewal went unwritten. A
     * paraphrase is where that answer stops being checkable against the ledger,
     * and the refusals — "they replied", "the ball is ours" — are the half a
     * person actually acts on.
     */
    const { db, service, composeAndHold } = build({
      compose: {
        held: false,
        stage: "eligibility",
        reason: "The outstanding next step is ours, so chasing them would be wrong.",
      },
    });

    const report = await service.sweep(ORG, { limit: 50, asOf: AS_OF });

    expect(composeAndHold).toHaveBeenCalledTimes(1);
    expect(db.setPayloads().find((payload) => payload.outcome === "skipped")).toMatchObject({
      outcome: "skipped",
      refusalStage: "eligibility",
      refusalReason: "The outstanding next step is ours, so chasing them would be wrong.",
      autonomyHoldId: null,
      outboundMessageId: null,
    });
    expect(report).toMatchObject({ opened: 1, held: 0 });
  });

  it("survives the loop being unreachable, and says so", async () => {
    /**
     * One contract that could not be considered must not end a sweep over two
     * hundred of them. `loop-error` is a stage of its own because an outage and
     * a judgement are different facts: the first is worth retrying, the second
     * is worth reading.
     */
    const { db, service } = build({ composeThrows: new Error("gateway timeout") });

    const report = await service.sweep(ORG, { limit: 50, asOf: AS_OF });

    expect(db.setPayloads().find((payload) => payload.outcome === "skipped")).toMatchObject({
      refusalStage: "loop-error",
      refusalReason: "gateway timeout",
    });
    expect(report.considered).toBe(1);
  });
});

describe("when there is nobody to write as", () => {
  it("never reaches the loop, and never opens an opportunity", async () => {
    /**
     * `judgeDraft` refuses with `no-sender-name` when there is no salesperson to
     * write as, so this would end in a refusal anyway — after a provider call
     * the tenant is billed for, and after a renewal opportunity assigned to
     * nobody had been left in the pipeline.
     */
    const { db, service, composeAndHold, createDeal } = build({
      candidates: [{ ...DUE_CANDIDATE, ownerUserId: null }],
    });

    const report = await service.sweep(ORG, { limit: 50, asOf: AS_OF });

    expect(createDeal).not.toHaveBeenCalled();
    expect(composeAndHold).not.toHaveBeenCalled();
    expect(db.setPayloads().find((payload) => payload.outcome === "skipped")).toMatchObject({
      refusalStage: "opportunity",
    });
    expect(report).toMatchObject({ held: 0 });
  });
});

describe("when another sweep already claimed the term", () => {
  it("opens nothing and asks nothing", async () => {
    // `onConflictDoNothing` returned no row, which means the other sweep owns
    // this contract. Retrying here would read a row it is still writing.
    const { service, composeAndHold, createDeal } = build({ claim: [] });

    const report = await service.sweep(ORG, { limit: 50, asOf: AS_OF });

    expect(createDeal).not.toHaveBeenCalled();
    expect(composeAndHold).not.toHaveBeenCalled();
    expect(report).toMatchObject({ opened: 0, considered: 1 });
    expect(report.entries[0]).toMatchObject({
      action: "stood-down",
      reason: "claimed-elsewhere",
    });
  });
});

describe("a term the decider stands down on", () => {
  it("is not claimed, not opened, and not offered", async () => {
    const { db, service, composeAndHold, createDeal } = build({
      candidates: [{ ...DUE_CANDIDATE, status: "churned" }],
    });

    const report = await service.sweep(ORG, { limit: 50, asOf: AS_OF });

    expect(db.calls.some((call) => call.method === "insert")).toBe(false);
    expect(createDeal).not.toHaveBeenCalled();
    expect(composeAndHold).not.toHaveBeenCalled();
    expect(report.entries[0]).toMatchObject({ action: "stood-down", reason: "term-closed" });
  });
});

describe("a conversation the loop already declined once", () => {
  it("is re-offered against the opportunity that exists, not a second one", async () => {
    /**
     * The failure this prevents is the expensive one: a re-offer that opened
     * another opportunity would give one contract a new deal every two days and
     * a forecast made of duplicates.
     */
    const { db, service, composeAndHold, createDeal } = build({
      candidates: [
        {
          ...DUE_CANDIDATE,
          triggerId: "trg_1",
          triggerKind: "renewal-due",
          dueOn: "2026-07-02",
          opportunityDealId: 4242,
          attempts: 1,
          lastAttemptAt: new Date("2026-08-20T09:00:00.000Z"),
        },
      ],
    });

    const report = await service.sweep(ORG, { limit: 50, asOf: AS_OF });

    expect(createDeal).not.toHaveBeenCalled();
    expect(db.calls.some((call) => call.method === "insert")).toBe(false);
    expect(composeAndHold).toHaveBeenCalledWith({
      organizationId: ORG,
      partyId: PARTY,
      dealId: "4242",
    });
    expect(report).toMatchObject({ reoffered: 1, opened: 0, held: 1 });
  });

  it("counts the attempt, so the retry interval keeps bounding it", async () => {
    // `chk_customer_lifecycle_triggers_attempts` refuses an outcome with no
    // attempt behind it. A counter that stopped moving would make every
    // subsequent sweep look like the first and re-offer daily.
    const { db, service } = build({
      candidates: [
        {
          ...DUE_CANDIDATE,
          triggerId: "trg_1",
          triggerKind: "renewal-due",
          dueOn: "2026-07-02",
          opportunityDealId: 4242,
          attempts: 1,
          lastAttemptAt: new Date("2026-08-20T09:00:00.000Z"),
        },
      ],
    });

    await service.sweep(ORG, { limit: 50, asOf: AS_OF });

    const outcome = db.setPayloads().find((payload) => payload.outcome === "held");
    expect(outcome).toHaveProperty("attempts");
    expect(outcome?.lastAttemptAt).toBeInstanceOf(Date);
  });
});
