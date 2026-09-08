import type { AiGatewayService } from "../ai/core/gateway/ai-gateway.service";
import type { DealsService } from "../deals/deals.service";
import type { Db } from "../../db/drizzle.types";
import {
  activities,
  autonomousDecisions,
  autonomySwitches,
  crmPipelineStages,
  deals,
  quotes,
} from "../../db/schema";
import { AutonomyService } from "./autonomy.service";
import { AutonomyActionsService } from "./autonomy-actions.service";
import type { AutonomyHoldService } from "./autonomy-hold.service";
import type { AutonomyScoringService } from "./autonomy-scoring.service";
import type { Extraction } from "./extraction.schemas";

/**
 * What one inbound message causes, and what it is recorded as causing.
 *
 * The database stand-in answers the five reads this path makes and records every
 * write, so the assertions are about the ledger rather than about SQL. The deal
 * is read from a *queue*, which is the only way to state the case that matters:
 * a rep moving the card during the seconds the provider takes must not be
 * overwritten, and must not be misreported afterwards either.
 */

const ORG = "org-1";
const ACTIVITY = "activity-1";

const extraction = (over: Partial<Extraction> = {}): Extraction => ({
  nextStep: { description: "Send the revised pricing", dueDate: null, owner: "us" },
  stage: { suggestedStage: "PROPOSAL", evidence: "They asked for a proposal." },
  confidence: 0.95,
  summary: "They asked for a proposal.",
  ...over,
});

interface ActivityFixture {
  activityId: string;
  kind: string;
  occurredAt: Date;
  threadId: string | null;
  actorKind: string;
  source: string;
  subject: string | null;
  body: string | null;
  dealId: string | null;
  fromAddress: string | null;
}

interface DealFixture {
  id: number;
  name: string;
  stage: string;
  pipelineId: string | null;
  updatedAt: Date | null;
}

interface Recorder {
  decisions: Record<string, unknown>[];
  createdTasks: Record<string, unknown>[];
}

function query<T>(rows: T[]) {
  const chain = {
    then: (resolve: (value: T[]) => unknown, reject?: (error: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
    limit: async () => rows,
    // The thread read orders before it limits; every other read here does not.
    orderBy: () => chain,
  };
  return chain;
}

function makeDb(
  rec: Recorder,
  activity: ActivityFixture | null,
  /** One entry per `loadDeal`; the last is reused once exhausted. */
  dealReads: (DealFixture | null)[],
  stages: string[],
  /** What else is on this message's thread, newest first, as the read returns it. */
  thread: ActivityFixture[] = [],
  /** Quotes already on the deal. The leg refuses to draft a second one. */
  existingQuotes: { id: number }[] = [],
): Db {
  let dealRead = 0;

  return {
    select: () => ({
      from: (table: unknown) => {
        if (table === activities)
          return {
            // `loadActivity` joins the sender; `loadThread` does not. The two
            // reads are told apart by that rather than by call order, so a
            // reordering of the service does not silently swap the fixtures.
            leftJoin: () => ({ where: () => query(activity ? [activity] : []) }),
            where: () => query(thread),
          };

        if (table === deals)
          return {
            where: () => {
              const fixture = dealReads[Math.min(dealRead, dealReads.length - 1)] ?? null;
              dealRead += 1;
              return query(fixture ? [fixture] : []);
            },
          };

        if (table === crmPipelineStages)
          return { where: () => query(stages.map((key) => ({ key }))) };

        if (table === autonomySwitches)
          return {
            where: () =>
              query([{ organizationId: null, kind: "*", enabled: true, reason: null }]),
          };

        if (table === quotes) return { where: () => query(existingQuotes) };

        throw new Error("unexpected read");
      },
    }),
    insert: (table: unknown) => ({
      values: (row: Record<string, unknown>) => {
        if (table === autonomousDecisions) {
          rec.decisions.push(row);
          return Promise.resolve(undefined);
        }
        rec.createdTasks.push(row);
        return { returning: async () => [{ activityId: "task-new" }] };
      },
    }),
  } as unknown as Db;
}

/** The half that writes, on the same stand-in database as the half that decides. */
const makeActions = (db: Db, updateDeal: jest.Mock) =>
  new AutonomyActionsService(db, { updateDeal } as unknown as DealsService);

/**
 * The quote leg's two collaborators, with the opt-in off.
 *
 * Off is the product default, so these stand-ins keep every test in this file
 * describing the same system it described before the leg existed: `settingsFor`
 * answers `autoQuoteEnabled: false` and `maybeDraftQuote` returns before it can
 * reach either the hold service or the database. A test that wants the leg turns
 * it on explicitly, which is also the only way a tenant gets it.
 */
const makeQuoteLeg = (autoQuoteEnabled = false) => {
  const generateAndHoldQuote = jest.fn().mockResolvedValue({ held: true, quoteId: 1 });
  const holds = { generateAndHoldQuote } as unknown as AutonomyHoldService;
  const scoring = {
    settingsFor: jest.fn().mockResolvedValue({
      shadowSampleRate: 0.1,
      shadowDailyCap: 500,
      holdWindowSeconds: 60,
      autoQuoteEnabled,
    }),
  } as unknown as AutonomyScoringService;
  return { holds, scoring, generateAndHoldQuote };
};

function makeService(
  db: Db,
  result: unknown,
  updateDeal: jest.Mock,
): AutonomyService {
  const gateway = {
    invokeStructuredWithUsage: jest.fn().mockResolvedValue(result),
  } as unknown as AiGatewayService;

  const { holds, scoring } = makeQuoteLeg();
  return new AutonomyService(db, gateway, makeActions(db, updateDeal), holds, scoring);
}

/** The same service, with the quote leg reachable and its hold call observable. */
function makeServiceForQuotes(
  db: Db,
  result: unknown,
  updateDeal: jest.Mock,
  autoQuoteEnabled: boolean,
) {
  const gateway = {
    invokeStructuredWithUsage: jest.fn().mockResolvedValue(result),
  } as unknown as AiGatewayService;
  const { holds, scoring, generateAndHoldQuote } = makeQuoteLeg(autoQuoteEnabled);
  const service = new AutonomyService(
    db,
    gateway,
    makeActions(db, updateDeal),
    holds,
    scoring,
  );
  return { service, generateAndHoldQuote };
}

/** A pipeline that accepts the move, so the stage advance reports `applied`. */
const stageMoved = () =>
  jest.fn().mockResolvedValue({
    ok: true,
    deal: {},
    stageChanged: true,
    previousStage: "QUALIFIED",
  });

const ok = (data: Extraction) => ({ ok: true, data, aiUsage: { model: "fast-1" } });

/**
 * The same service, with the provider call kept so a test can read what would
 * have been sent. The window is only worth anything if it reaches the prompt.
 */
function makeServiceCapturingPrompt(db: Db, result: unknown, updateDeal = jest.fn()) {
  const invoke = jest.fn().mockResolvedValue(result);
  const gateway = { invokeStructuredWithUsage: invoke } as unknown as AiGatewayService;
  const { holds, scoring } = makeQuoteLeg();
  const service = new AutonomyService(db, gateway, makeActions(db, updateDeal), holds, scoring);

  const conversationSent = (): string => {
    const call = invoke.mock.calls[0]?.[0] as { prompt: { user: string } } | undefined;
    return call?.prompt.user ?? "";
  };

  return { service, invoke, conversationSent };
}

const OCCURRED = new Date("2026-08-25T09:00:00.000Z");

const REPLY: ActivityFixture = {
  activityId: ACTIVITY,
  kind: "email",
  occurredAt: OCCURRED,
  threadId: "thread-1",
  actorKind: "system",
  source: "gmail",
  subject: "Re: Q3 pricing",
  body: "That looks good, please send the proposal over and we will sign this week.",
  dealId: "7",
  fromAddress: "priya@example.com",
};

/** A neighbouring message on the same thread, `secondsBefore` the trigger. */
const neighbour = (
  activityId: string,
  body: string,
  secondsBefore: number,
): ActivityFixture => ({
  ...REPLY,
  activityId,
  kind: "note",
  source: "whatsapp",
  subject: null,
  occurredAt: new Date(OCCURRED.getTime() - secondsBefore * 1_000),
  body,
});

const DEAL: DealFixture = {
  id: 7,
  name: "Acme Q3",
  stage: "QUALIFIED",
  pipelineId: "pipeline-1",
  updatedAt: new Date("2026-08-24T12:00:00.000Z"),
};

const decisionsOfKind = (rec: Recorder, kind: string) =>
  rec.decisions.filter((row) => row.kind === kind);

describe("AutonomyService.processActivity", () => {
  /**
   * The deterministic gate was being called with its inputs stripped out —
   * `fromAddress: ""` — so of the five signals it decides on only the subject
   * phrases survived. A bounce from a mail server read as a customer replying,
   * and a deal could advance on the strength of a delivery failure.
   */
  describe("the deterministic gate gets the sender it decides on", () => {
    it("classifies a mailer-daemon bounce as a bounce and spends nothing", async () => {
      const rec: Recorder = { decisions: [], createdTasks: [] };
      const gatewayResult = ok(extraction());
      const db = makeDb(
        rec,
        {
          ...REPLY,
          subject: "Re: Q3 pricing",
          fromAddress: "mailer-daemon@mail.example.com",
        },
        [DEAL],
        ["QUALIFIED", "PROPOSAL"],
      );
      const updateDeal = jest.fn();
      const service = makeService(db, gatewayResult, updateDeal);

      await service.processActivity(ORG, ACTIVITY);

      expect(rec.decisions).toHaveLength(1);
      expect(rec.decisions[0]).toMatchObject({ outcome: "skipped" });
      expect(String(rec.decisions[0]?.summary)).toContain("bounce");
      expect(updateDeal).not.toHaveBeenCalled();
    });

    it("still lets a real sender through", async () => {
      const rec: Recorder = { decisions: [], createdTasks: [] };
      const db = makeDb(rec, REPLY, [DEAL], ["QUALIFIED", "PROPOSAL"]);
      const service = makeService(db, ok(extraction()), jest.fn().mockResolvedValue({
        ok: true,
        deal: {},
        stageChanged: true,
        previousStage: "QUALIFIED",
      }));

      await service.processActivity(ORG, ACTIVITY);

      expect(decisionsOfKind(rec, "task.extracted")[0]).toMatchObject({ outcome: "applied" });
    });
  });

  /**
   * "A skipped decision nobody recorded is indistinguishable from a decision
   * that never ran" is this file's own docblock, and two paths returned without
   * writing one — quietly shrinking the denominator the correction rate is
   * measured against.
   */
  describe("every path leaves a decision behind", () => {
    it("records a skip when there was nothing to work with", async () => {
      const rec: Recorder = { decisions: [], createdTasks: [] };
      const db = makeDb(rec, { ...REPLY, subject: "Hi", body: "ok" }, [DEAL], ["QUALIFIED"]);
      const service = makeService(db, ok(extraction()), jest.fn());

      await service.processActivity(ORG, ACTIVITY);

      expect(rec.decisions).toHaveLength(1);
      expect(rec.decisions[0]).toMatchObject({ kind: "task.extracted", outcome: "skipped" });
      // The refusal now says which judgement refused it. It used to say "too
      // short", which was true of the characters and never the reason.
      expect(String(rec.decisions[0]?.summary)).toContain("acknowledged");
    });

    it("records a skip when the next step is the customer's to do", async () => {
      const rec: Recorder = { decisions: [], createdTasks: [] };
      const db = makeDb(rec, { ...REPLY, dealId: null }, [], []);
      const service = makeService(
        db,
        ok(
          extraction({
            nextStep: { description: "They will send the signed contract", dueDate: null, owner: "them" },
          }),
        ),
        jest.fn(),
      );

      await service.processActivity(ORG, ACTIVITY);

      const tasks = decisionsOfKind(rec, "task.extracted");
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({ outcome: "skipped", model: "fast-1" });
      expect(rec.createdTasks).toHaveLength(0);
    });
  });

  /**
   * The stage was captured before the provider call and written afterwards with
   * no version, so a rep moving the deal during those seconds was overwritten —
   * and then the ledger recorded the *stale* stage as `fromStage` while
   * `deal_stage_transitions` recorded the real one. The disagreement is not
   * cosmetic: the reversal guard compares `toStage` against the deal's current
   * stage, so it passed, and a manager clicking "reverse" restored a stage the
   * deal had not been in since before the rep touched it.
   */
  describe("a concurrent human move", () => {
    it("passes the version it read, so the write is refused rather than winning", async () => {
      const rec: Recorder = { decisions: [], createdTasks: [] };
      const moved = { ...DEAL, stage: "NEGOTIATION", updatedAt: new Date("2026-08-24T12:00:04.000Z") };
      const db = makeDb(rec, REPLY, [DEAL, moved], ["QUALIFIED", "NEGOTIATION", "PROPOSAL"]);
      const updateDeal = jest.fn().mockResolvedValue({ ok: false, reason: "version_conflict" });
      const service = makeService(db, ok(extraction()), updateDeal);

      await service.processActivity(ORG, ACTIVITY);

      // The version is the one from the re-read, not the pre-call capture.
      expect(updateDeal).toHaveBeenCalledWith(
        ORG,
        "system",
        7,
        expect.objectContaining({ stage: "PROPOSAL", version: moved.updatedAt.toISOString() }),
        expect.anything(),
      );

      const stage = decisionsOfKind(rec, "stage.advanced")[0];
      expect(stage).toMatchObject({ outcome: "skipped" });
      expect(String(stage?.summary)).toContain("Somebody moved the deal");
    });

    it("records the stage the deal was actually in, not the one read before the call", async () => {
      const rec: Recorder = { decisions: [], createdTasks: [] };
      const moved = { ...DEAL, stage: "NEGOTIATION", updatedAt: new Date("2026-08-24T12:00:04.000Z") };
      const db = makeDb(rec, REPLY, [DEAL, moved], ["QUALIFIED", "NEGOTIATION", "PROPOSAL"]);
      const updateDeal = jest.fn().mockResolvedValue({
        ok: true,
        deal: {},
        stageChanged: true,
        previousStage: "NEGOTIATION",
      });
      const service = makeService(db, ok(extraction()), updateDeal);

      await service.processActivity(ORG, ACTIVITY);

      const stage = decisionsOfKind(rec, "stage.advanced")[0];
      expect(stage).toMatchObject({ outcome: "applied" });
      expect(stage?.decision).toEqual({
        fromStage: "NEGOTIATION",
        toStage: "PROPOSAL",
        evidence: "They asked for a proposal.",
      });
    });

    it("does nothing when the human already moved it to the suggested stage", async () => {
      const rec: Recorder = { decisions: [], createdTasks: [] };
      const already = { ...DEAL, stage: "PROPOSAL" };
      const db = makeDb(rec, REPLY, [DEAL, already], ["QUALIFIED", "PROPOSAL"]);
      const updateDeal = jest.fn();
      const service = makeService(db, ok(extraction()), updateDeal);

      await service.processActivity(ORG, ACTIVITY);

      expect(updateDeal).not.toHaveBeenCalled();
      expect(decisionsOfKind(rec, "stage.advanced")).toHaveLength(0);
    });
  });

  /**
   * `ok` is not the same as "it moved". A blueprint that requires approval
   * returns success having only raised a request, and a blueprint that refuses
   * the transition throws — which, uncaught, retried the whole workflow five
   * times and dead-lettered it without writing any decision at all.
   */
  describe("a move that did not happen is not recorded as applied", () => {
    it("records a skip when the pipeline asked for approval instead", async () => {
      const rec: Recorder = { decisions: [], createdTasks: [] };
      const db = makeDb(rec, REPLY, [DEAL], ["QUALIFIED", "PROPOSAL"]);
      const updateDeal = jest.fn().mockResolvedValue({
        ok: true,
        deal: {},
        stageChanged: false,
        previousStage: null,
        approvalPending: true,
        approvalId: 1,
      });
      const service = makeService(db, ok(extraction()), updateDeal);

      await service.processActivity(ORG, ACTIVITY);

      const stage = decisionsOfKind(rec, "stage.advanced")[0];
      expect(stage).toMatchObject({ outcome: "skipped" });
      expect(String(stage?.summary)).toContain("approval");
    });

    it("records a failure rather than throwing into the retry loop", async () => {
      const rec: Recorder = { decisions: [], createdTasks: [] };
      const db = makeDb(rec, REPLY, [DEAL], ["QUALIFIED", "PROPOSAL"]);
      const updateDeal = jest
        .fn()
        .mockRejectedValue(new Error("Stage transition blocked: missing required fields"));
      const service = makeService(db, ok(extraction()), updateDeal);

      await expect(service.processActivity(ORG, ACTIVITY)).resolves.toBeUndefined();

      const stage = decisionsOfKind(rec, "stage.advanced")[0];
      expect(stage).toMatchObject({ outcome: "failed" });
      expect(String(stage?.summary)).toContain("Stage transition blocked");
    });
  });

  it("records a skip when the deal was deleted while the extraction ran", async () => {
    const rec: Recorder = { decisions: [], createdTasks: [] };
    const db = makeDb(rec, REPLY, [DEAL, null], ["QUALIFIED", "PROPOSAL"]);
    const updateDeal = jest.fn();
    const service = makeService(db, ok(extraction()), updateDeal);

    await service.processActivity(ORG, ACTIVITY);

    expect(updateDeal).not.toHaveBeenCalled();
    expect(decisionsOfKind(rec, "stage.advanced")[0]).toMatchObject({ outcome: "skipped" });
  });
});

/**
 * Ticket 23. `processActivity` takes one activity id, and on a messaging channel
 * a thought is not a message — five fragments in twenty seconds are one decision
 * and no single one of them carries it. These are the cases that say the
 * extractor is shown the thread, and the ones that say what the window costs.
 */
describe("AutonomyService reads a thread, not only an activity", () => {
  const FRAGMENT: ActivityFixture = {
    ...REPLY,
    kind: "note",
    source: "whatsapp",
    subject: null,
    body: "go ahead",
    dealId: null,
  };

  it("puts the neighbouring messages on the same thread into the prompt", async () => {
    const rec: Recorder = { decisions: [], createdTasks: [] };
    const trigger: ActivityFixture = {
      ...FRAGMENT,
      body: "can you send the contract over today",
    };
    const db = makeDb(rec, trigger, [], [], [
      trigger,
      neighbour("burst-2", "so we're good to go ahead", 7),
      neighbour("burst-1", "we got sign off on the budget yesterday", 15),
    ]);
    const { service, conversationSent } = makeServiceCapturingPrompt(db, ok(extraction()));

    await service.processActivity(ORG, ACTIVITY);

    const sent = conversationSent();
    expect(sent).toContain("we got sign off on the budget yesterday");
    expect(sent).toContain("so we're good to go ahead");
    expect(sent).toContain("can you send the contract over today");
    // Oldest first, so a later message reads as answering an earlier one.
    expect(sent.indexOf("sign off")).toBeLessThan(sent.indexOf("send the contract"));
  });

  /**
   * The finding ticket 12 could not gate on: a deadline is not invented, it is
   * lost, so no gate goes red while the date goes missing. Whether the model
   * attaches it is the eval's question; this is the half that is this service's
   * — that both halves reach one prompt at all.
   */
  it("shows a request and the deadline stated after it in the same conversation", async () => {
    const rec: Recorder = { decisions: [], createdTasks: [] };
    const trigger: ActivityFixture = {
      ...FRAGMENT,
      body: "by friday the 4th of september please",
    };
    const db = makeDb(rec, trigger, [], [], [
      trigger,
      neighbour("split-1", "can you send over the updated quote", 6),
    ]);
    const { service, conversationSent } = makeServiceCapturingPrompt(db, ok(extraction()));

    await service.processActivity(ORG, ACTIVITY);

    expect(conversationSent()).toContain(
      "can you send over the updated quote\n\nby friday the 4th of september please",
    );
  });

  it("records what the window cost, so the spend is a query rather than an argument", async () => {
    const rec: Recorder = { decisions: [], createdTasks: [] };
    const trigger: ActivityFixture = { ...FRAGMENT, body: "can you send the contract over today" };
    const db = makeDb(rec, trigger, [], [], [
      trigger,
      neighbour("burst-2", "so we're good to go ahead", 7),
    ]);
    const service = makeService(db, ok(extraction()), jest.fn());

    await service.processActivity(ORG, ACTIVITY);

    const inputs = decisionsOfKind(rec, "task.extracted")[0]?.inputs as {
      threadWindow: { messages: number; characters: number; dropped: number };
    };
    // Both messages and the separator between them — 25 + 2 + 36. The number is
    // written out because it is the thing this record exists to make checkable.
    expect(inputs.threadWindow).toEqual({ messages: 2, characters: 63, dropped: 0 });
  });

  describe("the fragment that used to be stopped by a character count", () => {
    it("spends nothing on a fragment with no conversation around it", async () => {
      const rec: Recorder = { decisions: [], createdTasks: [] };
      const db = makeDb(rec, FRAGMENT, [], [], [FRAGMENT]);
      const { service, invoke } = makeServiceCapturingPrompt(db, ok(extraction()));

      await service.processActivity(ORG, ACTIVITY);

      expect(invoke).not.toHaveBeenCalled();
      expect(String(rec.decisions[0]?.summary)).toContain("fragment");
    });

    /**
     * And the same eight characters, read with the four messages that make sense
     * of them, is a decision worth paying for. That is the whole difference
     * between a length rule and a judgement.
     */
    it("reads the same fragment once the thread gives it a meaning", async () => {
      const rec: Recorder = { decisions: [], createdTasks: [] };
      const db = makeDb(rec, FRAGMENT, [], [], [
        FRAGMENT,
        neighbour("burst-2", "so we're good to go ahead", 7),
        neighbour("burst-1", "we got sign off on the budget yesterday", 15),
      ]);
      const { service, invoke } = makeServiceCapturingPrompt(db, ok(extraction()));

      await service.processActivity(ORG, ACTIVITY);

      expect(invoke).toHaveBeenCalledTimes(1);
    });
  });

  describe("one request is one task, however many messages can see it", () => {
    const already: ActivityFixture = {
      ...FRAGMENT,
      activityId: "task-earlier",
      kind: "task",
      source: "extraction",
      subject: "Send the revised pricing",
      body: null,
    };

    it("refuses a next step this thread already produced, and records why", async () => {
      const rec: Recorder = { decisions: [], createdTasks: [] };
      const trigger: ActivityFixture = { ...FRAGMENT, body: "any update on that quote" };
      const db = makeDb(rec, trigger, [], [], [
        trigger,
        { ...already, occurredAt: new Date(OCCURRED.getTime() - 60_000) },
      ]);
      const service = makeService(db, ok(extraction()), jest.fn());

      await service.processActivity(ORG, ACTIVITY);

      expect(rec.createdTasks).toHaveLength(0);
      const decision = decisionsOfKind(rec, "task.extracted")[0];
      expect(decision).toMatchObject({ outcome: "skipped" });
      expect(String(decision?.summary)).toContain("already produced");
    });

    it("files the task on the thread it came out of, so the next message can see it", async () => {
      const rec: Recorder = { decisions: [], createdTasks: [] };
      const trigger: ActivityFixture = { ...FRAGMENT, body: "can you send the revised pricing" };
      const db = makeDb(rec, trigger, [], [], [trigger]);
      const service = makeService(db, ok(extraction()), jest.fn());

      await service.processActivity(ORG, ACTIVITY);

      expect(rec.createdTasks[0]).toMatchObject({
        threadId: "thread-1",
        source: "extraction",
        subject: "Send the revised pricing",
      });
    });
  });

  /**
   * A message the seam could not thread has no neighbours by definition, and
   * asking for them would scan every unthreaded activity in the organisation.
   */
  it("asks for no neighbours when the message was never threaded", async () => {
    const rec: Recorder = { decisions: [], createdTasks: [] };
    const trigger: ActivityFixture = { ...REPLY, threadId: null, dealId: null };
    const db = makeDb(rec, trigger, [], [], [
      neighbour("other", "a message on somebody else's thread", 10),
    ]);
    const { service, conversationSent } = makeServiceCapturingPrompt(db, ok(extraction()));

    await service.processActivity(ORG, ACTIVITY);

    expect(conversationSent()).not.toContain("somebody else's thread");
  });
});

/**
 * The quote leg — the half of the golden path that had no production caller.
 *
 * `generateAndHoldQuote` was written, reviewed and left unreached: nothing in
 * `src/` called it, so the path `pending.md` specifies as "quote drafted into
 * hold" existed only as a method somebody could have called. These tests are the
 * caller's contract, and the first of them is the one that matters most — the
 * default is still that nothing is quoted.
 */
describe("AutonomyService drafts a quote when a deal moves", () => {
  const STAGES = ["QUALIFIED", "PROPOSAL"];
  /** `loadDeal` is read twice on this path: once by the caller, once after. */
  const dealReads = () => [DEAL, DEAL];

  it("drafts nothing when the organisation never opted in", async () => {
    const rec: Recorder = { decisions: [], createdTasks: [] };
    const db = makeDb(rec, REPLY, dealReads(), STAGES);
    const { service, generateAndHoldQuote } = makeServiceForQuotes(
      db, ok(extraction()), stageMoved(), false,
    );

    await service.processActivity(ORG, ACTIVITY);

    // The move still happens. Only the quote is withheld.
    expect(decisionsOfKind(rec, "stage.advanced")[0]).toMatchObject({ outcome: "applied" });
    expect(generateAndHoldQuote).not.toHaveBeenCalled();
    // Not even a skip: a tenant who never asked for this should not have their
    // review feed filling up with quotes the system declined to draft.
    expect(decisionsOfKind(rec, "quote.sent")).toHaveLength(0);
  });

  it("drafts and holds one once the organisation has opted in", async () => {
    const rec: Recorder = { decisions: [], createdTasks: [] };
    const db = makeDb(rec, REPLY, dealReads(), STAGES);
    const { service, generateAndHoldQuote } = makeServiceForQuotes(
      db, ok(extraction()), stageMoved(), true,
    );

    await service.processActivity(ORG, ACTIVITY);

    expect(generateAndHoldQuote).toHaveBeenCalledWith({
      organizationId: ORG,
      dealId: 7,
      confidence: 0.95,
    });
  });

  it("drafts nothing when the deal did not actually move", async () => {
    const rec: Recorder = { decisions: [], createdTasks: [] };
    const db = makeDb(rec, REPLY, dealReads(), STAGES);
    // The pipeline raised an approval request rather than making the move, so
    // `applyStageAdvance` reports `skipped` and there is no advance to quote off.
    const updateDeal = jest.fn().mockResolvedValue({
      ok: true, deal: {}, stageChanged: false, approvalPending: true,
    });
    const { service, generateAndHoldQuote } = makeServiceForQuotes(
      db, ok(extraction()), updateDeal, true,
    );

    await service.processActivity(ORG, ACTIVITY);

    expect(decisionsOfKind(rec, "stage.advanced")[0]).toMatchObject({ outcome: "skipped" });
    expect(generateAndHoldQuote).not.toHaveBeenCalled();
  });

  it("records a skip rather than quoting below the threshold a quote carries", async () => {
    const rec: Recorder = { decisions: [], createdTasks: [] };
    const db = makeDb(rec, REPLY, dealReads(), STAGES);
    // 0.88 clears `stage.advanced` at 0.85 and misses `quote.sent` at 0.9 — the
    // gap the two thresholds exist to create.
    const { service, generateAndHoldQuote } = makeServiceForQuotes(
      db, ok(extraction({ confidence: 0.88 })), stageMoved(), true,
    );

    await service.processActivity(ORG, ACTIVITY);

    expect(decisionsOfKind(rec, "stage.advanced")[0]).toMatchObject({ outcome: "applied" });
    expect(generateAndHoldQuote).not.toHaveBeenCalled();
    const skipped = decisionsOfKind(rec, "quote.sent")[0];
    expect(skipped).toMatchObject({ outcome: "skipped" });
    expect(String(skipped?.summary)).toContain("below what a quote needs");
  });

  it("does not quote a deal somebody has already quoted", async () => {
    const rec: Recorder = { decisions: [], createdTasks: [] };
    const db = makeDb(rec, REPLY, dealReads(), STAGES, [], [{ id: 42 }]);
    const { service, generateAndHoldQuote } = makeServiceForQuotes(
      db, ok(extraction()), stageMoved(), true,
    );

    await service.processActivity(ORG, ACTIVITY);

    expect(generateAndHoldQuote).not.toHaveBeenCalled();
    const skipped = decisionsOfKind(rec, "quote.sent")[0];
    expect(skipped).toMatchObject({ outcome: "skipped" });
    expect(String(skipped?.summary)).toContain("already has a quote");
  });

  it("records a failed decision rather than throwing into the retry loop", async () => {
    const rec: Recorder = { decisions: [], createdTasks: [] };
    const db = makeDb(rec, REPLY, dealReads(), STAGES);
    const { service, generateAndHoldQuote } = makeServiceForQuotes(
      db, ok(extraction()), stageMoved(), true,
    );
    generateAndHoldQuote.mockRejectedValue(new Error("quote numbering is exhausted"));

    // The stage advance has already committed. Throwing would retry the whole
    // workflow and re-apply a move that happened.
    await expect(service.processActivity(ORG, ACTIVITY)).resolves.toBeUndefined();

    const failed = decisionsOfKind(rec, "quote.sent")[0];
    expect(failed).toMatchObject({ outcome: "failed" });
    expect(String(failed?.summary)).toContain("quote numbering is exhausted");
  });
});
