import type { Db } from "../../db/drizzle.types";
import type { AiGatewayService } from "../ai/core/gateway/ai-gateway.service";
import {
  CALL_ANALYSIS_ANALYZER_VERSION,
  type CallAnalysisJudgement,
} from "./call-analysis.contract";
import type { CallRecordingConsentService } from "./call-recording-consent.service";
import { CallAnalysisService } from "./call-analysis.service";
import { transcriptHash } from "./transcript-hash";

/**
 * The cache is the ticket, so the cache is what is on trial.
 *
 * The property that matters is not "the second call is faster". It is that the
 * second call makes NO provider request and returns the byte-identical answer —
 * because a language model asked the same question twice does not agree with
 * itself, and a customer record whose objections change depending on when
 * somebody last opened it is worse than one with no analysis at all. The
 * gateway double below counts its invocations for exactly that reason.
 *
 * The second thing on trial is that nothing reaches a model provider except
 * through `AiGatewayService`. The double is the whole of this service's access
 * to one; if a raw SDK were ever introduced, `invocations` would stay at zero
 * while an analysis appeared, and the first test here would fail.
 */

/**
 * A consent service that allows everything, so this file keeps testing the cache.
 *
 * The consent gate is real and is a constructor dependency of the service under
 * test (phase 5 ticket 03) — every path through `analyse` and `find` passes it.
 * Stubbing it to "allowed" here is not a loophole: what this file is on trial
 * for is that the same transcript costs one model call and reads the same twice,
 * and a refusal would make every case below vacuous. The gate itself is driven
 * from both sides in `call-analysis-consent-gate.spec.ts`, which asserts that a
 * refused call reaches neither the model nor the store — including from cache.
 */
const ALLOWED = {
  decide: async () => ({
    activityId: ACTIVITY,
    verdict: { allowed: true as const, regime: "one-party" as const, jurisdiction: "US-NY", ruleVersion: 1 },
    basis: null,
  }),
  recordRefusal: async () => {},
} as unknown as CallRecordingConsentService;

const ORG = "org-1";
const OTHER_ORG = "org-2";
const ACTIVITY = "act-1";
const USER = "user-1";

const TRANSCRIPT = [
  "Rep: Thanks for the time. What are you using today?",
  "Customer: Acme. Honestly the price here looks steep.",
  "Rep: I hear that. Can I show you total cost side by side?",
  "Customer: Send it over and we will book a call Thursday.",
].join("\n");

interface ActivityRow {
  activityId: string;
  kind: string;
  body: string | null;
  occurredAt: Date;
}

const call = (over: Partial<ActivityRow> = {}): ActivityRow => ({
  activityId: ACTIVITY,
  kind: "call",
  body: TRANSCRIPT,
  occurredAt: new Date("2026-08-20T10:00:00.000Z"),
  ...over,
});

interface AnalysisRow {
  callAnalysisId: string;
  organizationId: string;
  transcriptHash: string;
  analyzerVersion: number;
  activityId: string;
  talkRatioBps: number | null;
  repTurnCount: number | null;
  repQuestionCount: number | null;
  objections: unknown;
  competitorMentions: unknown;
  nextStepCommitted: boolean;
  nextStep: string | null;
  model: string | null;
  promptKey: string;
  promptVersion: number;
  transcriptChars: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Enough of Drizzle to answer the two reads and take the one write.
 *
 * The predicates are honoured rather than ignored, which is the difference
 * between a double and a lie: `paramValues` pulls the bound values out of the
 * `and(eq(...))` clause the service built, and each read matches on them. A
 * double that returned the first row whatever it was asked would have reported
 * the cache working for an edited transcript, which is the one failure this
 * file exists to catch.
 */
function paramValues(clause: unknown): unknown[] {
  const found: unknown[] = [];
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    // Only two shapes are followed: a `SQL` (which carries `queryChunks`) and a
    // bound `Param`. Walking anything else would step from a column onto its
    // table and back onto every column it has.
    if (Array.isArray(record["queryChunks"])) {
      for (const chunk of record["queryChunks"]) walk(chunk);
      return;
    }
    if ("value" in record && "encoder" in record) found.push(record["value"]);
  };
  walk(clause);
  return found;
}

function makeDb(activityRows: ActivityRow[], store: AnalysisRow[]) {
  const inserted: Record<string, unknown>[] = [];
  const whereClauses: unknown[] = [];

  const db = {
    select: jest.fn().mockImplementation((projection?: unknown) => ({
      from: jest.fn().mockImplementation(() => ({
        where: jest.fn().mockImplementation((clause: unknown) => {
          whereClauses.push(clause);
          const bound = paramValues(clause);
          return {
            limit: jest.fn().mockImplementation(async () =>
              // `select()` with no projection is the analysis read; the call
              // read projects four named columns.
              projection === undefined
                ? store.filter(
                    (row) =>
                      bound.includes(row.organizationId) &&
                      bound.includes(row.transcriptHash) &&
                      bound.includes(row.analyzerVersion),
                  )
                : activityRows.filter((row) => bound.includes(row.activityId)),
            ),
          };
        }),
      })),
    })),
    insert: jest.fn().mockImplementation(() => ({
      values: jest.fn().mockImplementation((row: Record<string, unknown>) => ({
        onConflictDoNothing: jest.fn().mockImplementation(async () => {
          inserted.push(row);
          store.push(asStored(row));
        }),
      })),
    })),
  } as unknown as Db;

  return { db, inserted, whereClauses };
}

function asStored(row: Record<string, unknown>): AnalysisRow {
  return {
    callAnalysisId: "analysis-1",
    createdAt: new Date("2026-08-21T09:00:00.000Z"),
    updatedAt: new Date("2026-08-21T09:00:00.000Z"),
    ...(row as unknown as Omit<AnalysisRow, "callAnalysisId" | "createdAt" | "updatedAt">),
  };
}

interface GatewayStub {
  gateway: AiGatewayService;
  invocations: () => number;
  prompts: () => string[];
}

const JUDGEMENT: CallAnalysisJudgement = {
  repSpeakers: ["Rep"],
  objections: [
    {
      quote: "Honestly the price here looks steep.",
      handling: "answered",
      response: "Can I show you total cost side by side?",
    },
  ],
  competitorMentions: [{ name: "Acme", quote: "Acme. Honestly the price here looks steep." }],
  nextStepCommitted: true,
  nextStep: "Send the cost comparison and hold a call on Thursday.",
};

function makeGateway(
  answer:
    | { ok: true; data: CallAnalysisJudgement }
    | { ok: false; kind: string; message: string } = {
    ok: true,
    data: JUDGEMENT,
  },
): GatewayStub {
  const prompts: string[] = [];
  const gateway = {
    invokeStructuredWithUsage: jest
      .fn()
      .mockImplementation(async (opts: { prompt: { user: string } }) => {
        prompts.push(opts.prompt.user);
        return answer.ok
          ? { ok: true, data: answer.data, aiUsage: { model: "test-model" } }
          : { ok: false, kind: answer.kind, message: answer.message, correlationId: "c1" };
      }),
  } as unknown as AiGatewayService;

  return {
    gateway,
    invocations: () =>
      (gateway.invokeStructuredWithUsage as unknown as jest.Mock).mock.calls.length,
    prompts: () => prompts,
  };
}

describe("analysing a completed call", () => {
  it("costs one model call the first time and none the second", async () => {
    const store: AnalysisRow[] = [];
    const { db } = makeDb([call()], store);
    const stub = makeGateway();
    const service = new CallAnalysisService(db, stub.gateway, ALLOWED);

    const first = await service.analyse(ORG, USER, ACTIVITY);
    const second = await service.analyse(ORG, USER, ACTIVITY);

    expect(first.ok && first.cached).toBe(false);
    expect(second.ok && second.cached).toBe(true);
    expect(stub.invocations()).toBe(1);
  });

  it("returns the identical answer the second time, not merely a similar one", async () => {
    const store: AnalysisRow[] = [];
    const { db } = makeDb([call()], store);
    // A gateway that would answer differently if asked again. It is not asked.
    const service = new CallAnalysisService(db, makeGateway().gateway, ALLOWED);

    const first = await service.analyse(ORG, USER, ACTIVITY);
    const second = await service.analyse(ORG, USER, ACTIVITY);

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error("unreachable");
    expect(second.analysis).toEqual(first.analysis);
  });

  it("is free for a second call carrying the same transcript", async () => {
    // The whole reason the key is the transcript and not the activity: a replay
    // or a re-import files the same conversation as a new timeline row.
    const store: AnalysisRow[] = [];
    const copy = call({ activityId: "act-2" });
    const { db } = makeDb([call()], store);
    const stub = makeGateway();
    const service = new CallAnalysisService(db, stub.gateway, ALLOWED);

    await service.analyse(ORG, USER, ACTIVITY);
    const { db: db2 } = makeDb([copy], store);
    const again = await new CallAnalysisService(db2, stub.gateway, ALLOWED).analyse(
      ORG,
      USER,
      "act-2",
    );

    expect(again.ok && again.cached).toBe(true);
    expect(stub.invocations()).toBe(1);
    // The row still names the call it was first produced for. Repointing it
    // would make the cached answer look like it came from whichever copy asked
    // most recently.
    expect(again.ok && again.analysis.activityId).toBe(ACTIVITY);
  });

  it("keys the cache on the transcript, so an edited transcript is analysed again", async () => {
    const store: AnalysisRow[] = [];
    const stub = makeGateway();
    const { db } = makeDb([call()], store);
    await new CallAnalysisService(db, stub.gateway, ALLOWED).analyse(ORG, USER, ACTIVITY);

    const { db: db2 } = makeDb([call({ body: `${TRANSCRIPT}\nCustomer: One more thing.` })], store);
    await new CallAnalysisService(db2, stub.gateway, ALLOWED).analyse(ORG, USER, ACTIVITY);

    expect(stub.invocations()).toBe(2);
    expect(store).toHaveLength(2);
  });

  it("records the counted metrics rather than anything the model said about them", async () => {
    const store: AnalysisRow[] = [];
    const { db, inserted } = makeDb([call()], store);
    const outcome = await new CallAnalysisService(db, makeGateway().gateway, ALLOWED).analyse(
      ORG,
      USER,
      ACTIVITY,
    );

    if (!outcome.ok) throw new Error("expected an analysis");
    // 21 of the 38 words are the rep's, and the rep asked two questions across
    // two turns. Neither number came from the model; both are arithmetic on the
    // transcript, which is why they are reproducible.
    expect(outcome.analysis.talkRatioBps).toBe(5526);
    expect(outcome.analysis.repTurnCount).toBe(2);
    expect(outcome.analysis.repQuestionCount).toBe(2);
    expect(outcome.analysis.questionRateBps).toBe(10000);
    expect(inserted[0]?.talkRatioBps).toBe(5526);
  });

  it("leaves the metrics unknown when the transcript has no speakers", async () => {
    // Not zero, and not fifty percent. A manager must not coach a rep on a
    // number that was invented because the field could not be empty.
    const prose = "The customer called about pricing and asked for a comparison by Friday.";
    const store: AnalysisRow[] = [];
    const { db } = makeDb([call({ body: prose })], store);
    const stub = makeGateway({ ok: true, data: { ...JUDGEMENT, repSpeakers: [] } });

    const outcome = await new CallAnalysisService(db, stub.gateway, ALLOWED).analyse(ORG, USER, ACTIVITY);

    if (!outcome.ok) throw new Error("expected an analysis");
    expect(outcome.analysis.talkRatioBps).toBeNull();
    expect(outcome.analysis.repTurnCount).toBeNull();
    expect(outcome.analysis.questionRateBps).toBeNull();
    // The judgements still land: a transcript with no speaker labels is still a
    // call somebody objected during.
    expect(outcome.analysis.objections).toHaveLength(1);
  });

  it("refuses a committed next step the model could not name", async () => {
    // Otherwise the next-step rate counts every polite goodbye, and the metric
    // reports every call as a success.
    const store: AnalysisRow[] = [];
    const { db } = makeDb([call()], store);
    const stub = makeGateway({
      ok: true,
      data: { ...JUDGEMENT, nextStepCommitted: true, nextStep: "   " },
    });

    const outcome = await new CallAnalysisService(db, stub.gateway, ALLOWED).analyse(ORG, USER, ACTIVITY);

    if (!outcome.ok) throw new Error("expected an analysis");
    expect(outcome.analysis.nextStepCommitted).toBe(false);
    expect(outcome.analysis.nextStep).toBeNull();
  });

  it("drops a quoted reply on an objection nobody answered", async () => {
    const store: AnalysisRow[] = [];
    const { db } = makeDb([call()], store);
    const stub = makeGateway({
      ok: true,
      data: {
        ...JUDGEMENT,
        objections: [
          { quote: "Too expensive.", handling: "unaddressed", response: "We moved on." },
        ],
      },
    });

    const outcome = await new CallAnalysisService(db, stub.gateway, ALLOWED).analyse(ORG, USER, ACTIVITY);

    if (!outcome.ok) throw new Error("expected an analysis");
    expect(outcome.analysis.objections[0]?.response).toBeNull();
  });
});

describe("refusing to analyse", () => {
  const service = (rows: ActivityRow[], stub = makeGateway()) => {
    const store: AnalysisRow[] = [];
    const { db } = makeDb(rows, store);
    return { service: new CallAnalysisService(db, stub.gateway, ALLOWED), stub, store };
  };

  it("refuses an activity that is not a call", async () => {
    const { service: s, stub } = service([call({ kind: "email" })]);
    const outcome = await s.analyse(ORG, USER, ACTIVITY);
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.reason).toBe("not-a-call");
    expect(stub.invocations()).toBe(0);
  });

  it("refuses a call that has not happened yet", async () => {
    // A future call is a plan somebody typed. Attributing objections and a talk
    // ratio to it would describe a conversation nobody has had.
    const { service: s, stub } = service([call({ occurredAt: new Date(Date.now() + 86_400_000) })]);
    const outcome = await s.analyse(ORG, USER, ACTIVITY);
    expect(!outcome.ok && outcome.reason).toBe("not-completed");
    expect(stub.invocations()).toBe(0);
  });

  it("refuses a call with no transcript rather than inferring one", async () => {
    // The telephony adapter files exactly this: a call with a duration, a
    // direction and no body. Nothing here turns that into text to judge.
    const { service: s, stub } = service([call({ body: null })]);
    const outcome = await s.analyse(ORG, USER, ACTIVITY);
    expect(!outcome.ok && outcome.reason).toBe("no-transcript");
    expect(stub.invocations()).toBe(0);
  });

  it("refuses a whitespace-only transcript for the same reason", async () => {
    const { service: s, stub } = service([call({ body: "   \n\n  " })]);
    expect((await s.analyse(ORG, USER, ACTIVITY)).ok).toBe(false);
    expect(stub.invocations()).toBe(0);
  });

  it("refuses a call this organisation cannot see", async () => {
    const { service: s } = service([]);
    const outcome = await s.analyse(OTHER_ORG, USER, ACTIVITY);
    expect(!outcome.ok && outcome.reason).toBe("not-found");
  });

  it("caches nothing when the model call fails", async () => {
    // A cached failure would be permanent: the key is the transcript, so
    // nothing would ever ask again.
    const stub = makeGateway({ ok: false, kind: "quota_exceeded", message: "no credits" });
    const { service: s, store } = service([call()], stub);

    const outcome = await s.analyse(ORG, USER, ACTIVITY);

    expect(!outcome.ok && outcome.reason).toBe("analysis-unavailable");
    expect(store).toHaveLength(0);

    const stub2 = makeGateway();
    const { service: s2 } = service([call()], stub2);
    expect((await s2.analyse(ORG, USER, ACTIVITY)).ok).toBe(true);
    expect(stub2.invocations()).toBe(1);
  });
});

describe("reading an analysis without producing one", () => {
  it("never reaches the model", async () => {
    const store: AnalysisRow[] = [];
    const { db } = makeDb([call()], store);
    const stub = makeGateway();

    expect(await new CallAnalysisService(db, stub.gateway, ALLOWED).find(ORG, ACTIVITY)).toBeNull();
    expect(stub.invocations()).toBe(0);
  });

  it("finds the row by the transcript's hash and this organisation's id", async () => {
    const store: AnalysisRow[] = [];
    const { db, whereClauses } = makeDb([call()], store);
    const stub = makeGateway();
    const service = new CallAnalysisService(db, stub.gateway, ALLOWED);

    await service.analyse(ORG, USER, ACTIVITY);
    const found = await service.find(ORG, ACTIVITY);

    expect(found?.transcriptHash).toBe(transcriptHash(TRANSCRIPT));
    expect(found?.analyzerVersion).toBe(CALL_ANALYSIS_ANALYZER_VERSION);
    // Every read carried a predicate. A tenant-scoped table queried without one
    // leaves RLS as the only thing between two customers' calls.
    expect(whereClauses.every((clause) => clause !== undefined)).toBe(true);
    expect(whereClauses.length).toBeGreaterThanOrEqual(3);
  });
});
