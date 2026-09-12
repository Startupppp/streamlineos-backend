import type { Db } from "../../db/drizzle.types";
import type { AiGatewayService } from "../ai/core/gateway/ai-gateway.service";
import { CALL_ANALYSIS_ANALYZER_VERSION } from "./call-analysis.contract";
import { CallAnalysisService } from "./call-analysis.service";
import type { CallConsentVerdict } from "./call-recording-consent";
import type {
  CallConsentDecision,
  CallRecordingConsentService,
} from "./call-recording-consent.service";

/**
 * A refused call reaches neither the model nor the reader — from either door.
 *
 * `call-recording-consent.spec.ts` proves the rule decides correctly. This
 * proves the decision is actually obeyed, which is the different claim and the
 * one that fails silently: a rule with a spec and no caller is the shape of
 * failure this repository has produced repeatedly.
 *
 * Two doors, and both had to be shut.
 *
 * `analyse` is the obvious one. A refusal there has to happen BEFORE the cache
 * read as well as before the model call — `crm:call-analysis:run` is held by
 * every CRM admin, and a POST that returned the cached row for a refused call
 * would be a way to read exactly the verbatim customer quotes the rule exists to
 * keep unread. A gate that only stopped the paid path would look like it worked
 * on a fresh call and do nothing on the second request.
 *
 * `find` is the one that is easy to miss. An analysis produced before this rule
 * shipped, or before somebody recorded a withdrawal, is already sitting in
 * `crm_call_analyses`. A read path that served it would make the whole ticket a
 * rule about new calls only.
 */

const ORG = "org-1";
const ACTIVITY = "act-1";
const USER = "user-1";

const TRANSCRIPT = [
  "Rep: Thanks for the time. What are you using today?",
  "Customer: Acme. Honestly the price here looks steep.",
].join("\n");

const REFUSED_NOTE =
  "There is no evidence the other party agreed to this call being recorded, and this is an all-party consent jurisdiction.";

const REFUSED: CallConsentVerdict = {
  allowed: false,
  regime: "two-party",
  jurisdiction: "US-CA",
  reason: "counterparty-consent-missing",
  note: REFUSED_NOTE,
  ruleVersion: 1,
};

const ALLOWED: CallConsentVerdict = {
  allowed: true,
  regime: "one-party",
  jurisdiction: "US-NY",
  ruleVersion: 1,
};

function consentStub(verdict: CallConsentVerdict) {
  const refusals: Array<{ activityId: string; reason: string }> = [];
  const decision: CallConsentDecision = { activityId: ACTIVITY, verdict, basis: null };

  const service = {
    decide: jest.fn(async () => decision),
    recordRefusal: jest.fn(async (_org: string, activityId: string, v: CallConsentVerdict) => {
      if (!v.allowed) refusals.push({ activityId, reason: v.reason });
    }),
  } as unknown as CallRecordingConsentService;

  return { service, refusals, decide: () => (service as unknown as { decide: jest.Mock }).decide };
}

/**
 * Enough of Drizzle to answer the call read and the cache read.
 *
 * `select()` with no projection is the analysis read; the call read projects
 * four named columns. That is the same discrimination `call-analysis.service.spec.ts`
 * makes, restated rather than shared because a double two files depend on drifts
 * into a framework.
 */
function makeDb(cachedRows: unknown[]) {
  const inserted: unknown[] = [];
  const db = {
    select: jest.fn().mockImplementation((projection?: unknown) => ({
      from: jest.fn().mockImplementation(() => ({
        where: jest.fn().mockImplementation(() => ({
          limit: jest.fn().mockImplementation(async () =>
            projection === undefined
              ? cachedRows
              : [
                  {
                    activityId: ACTIVITY,
                    kind: "call",
                    body: TRANSCRIPT,
                    occurredAt: new Date("2026-06-10T10:00:00.000Z"),
                  },
                ],
          ),
        })),
      })),
    })),
    insert: jest.fn().mockImplementation(() => ({
      values: jest.fn().mockImplementation((row: unknown) => ({
        onConflictDoNothing: jest.fn().mockImplementation(async () => {
          inserted.push(row);
        }),
      })),
    })),
  } as unknown as Db;

  return { db, inserted };
}

function gatewayStub() {
  let invocations = 0;
  const gateway = {
    invokeStructuredWithUsage: jest.fn(async () => {
      invocations += 1;
      return {
        ok: true,
        data: {
          repSpeakers: ["Rep"],
          objections: [],
          competitorMentions: [],
          nextStepCommitted: false,
          nextStep: null,
        },
        aiUsage: { model: "test-model" },
      };
    }),
  } as unknown as AiGatewayService;
  return { gateway, invocations: () => invocations };
}

const storedRow = () => ({
  callAnalysisId: "analysis-1",
  organizationId: ORG,
  transcriptHash: "hash",
  analyzerVersion: CALL_ANALYSIS_ANALYZER_VERSION,
  activityId: ACTIVITY,
  talkRatioBps: 5000,
  repTurnCount: 1,
  repQuestionCount: 1,
  objections: [{ quote: "the price here looks steep", handling: "answered", response: "sure" }],
  competitorMentions: [{ name: "Acme", quote: "Acme." }],
  nextStepCommitted: false,
  nextStep: null,
  model: "test-model",
  promptKey: "call-analysis",
  promptVersion: 1,
  transcriptChars: TRANSCRIPT.length,
  createdAt: new Date("2026-06-10T11:00:00.000Z"),
  updatedAt: new Date("2026-06-10T11:00:00.000Z"),
});

describe("analysing a call the consent rule refused", () => {
  it("makes no model call and stores no transcript", async () => {
    const { db, inserted } = makeDb([]);
    const stub = gatewayStub();
    const consent = consentStub(REFUSED);

    const outcome = await new CallAnalysisService(db, stub.gateway, consent.service).analyse(
      ORG,
      USER,
      ACTIVITY,
    );

    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.reason).toBe("consent-refused");
    // The two claims that are the ticket. If either of these ever passes with a
    // non-zero count, a two-party jurisdiction's recording has been processed.
    expect(stub.invocations()).toBe(0);
    expect(inserted).toEqual([]);
  });

  it("refuses before the cache, so a cached answer is not a way past the rule", async () => {
    /**
     * The bypass this case exists to close. Analyse a call while its
     * jurisdiction is unrecorded, fill the jurisdiction in as somewhere strict,
     * and the row is still in the table. A gate placed after the cache read
     * would hand it straight back and would have looked correct in every test
     * that only ever analysed fresh calls.
     */
    const { db } = makeDb([storedRow()]);
    const stub = gatewayStub();
    const consent = consentStub(REFUSED);

    const outcome = await new CallAnalysisService(db, stub.gateway, consent.service).analyse(
      ORG,
      USER,
      ACTIVITY,
    );

    expect(!outcome.ok && outcome.reason).toBe("consent-refused");
    expect(JSON.stringify(outcome)).not.toContain("price here looks steep");
  });

  it("records the refusal, so the gap is visible rather than silent", async () => {
    // Without the ledger a refusal is indistinguishable from a call nobody
    // thought to analyse: both render as an empty panel, and the team concludes
    // the feature is broken rather than that a compliance record is missing.
    const { db } = makeDb([]);
    const consent = consentStub(REFUSED);

    await new CallAnalysisService(db, gatewayStub().gateway, consent.service).analyse(
      ORG,
      USER,
      ACTIVITY,
    );

    expect(consent.refusals).toEqual([
      { activityId: ACTIVITY, reason: "counterparty-consent-missing" },
    ]);
  });

  it("carries the rule's own sentence to the caller rather than a slug", async () => {
    const { db } = makeDb([]);
    const outcome = await new CallAnalysisService(
      db,
      gatewayStub().gateway,
      consentStub(REFUSED).service,
    ).analyse(ORG, USER, ACTIVITY);

    expect(!outcome.ok && outcome.note).toBe(REFUSED_NOTE);
  });
});

describe("reading an analysis the consent rule refused", () => {
  it("returns nothing even though the row is in the table", async () => {
    /**
     * The case that makes this a rule about all calls rather than about new
     * ones. A row written before the gate shipped, or before a withdrawal was
     * recorded, is already stored — and it holds verbatim quotes from the
     * conversation.
     */
    const { db } = makeDb([storedRow()]);
    const consent = consentStub(REFUSED);

    const found = await new CallAnalysisService(
      db,
      gatewayStub().gateway,
      consent.service,
    ).find(ORG, ACTIVITY);

    expect(found).toBeNull();
    expect(consent.refusals).toHaveLength(1);
  });

  it("still returns the analysis when the rule allows it", async () => {
    // The other half, without which every case above would pass on a service
    // that returned null unconditionally.
    const { db } = makeDb([storedRow()]);
    const consent = consentStub(ALLOWED);

    const found = await new CallAnalysisService(
      db,
      gatewayStub().gateway,
      consent.service,
    ).find(ORG, ACTIVITY);

    expect(found?.activityId).toBe(ACTIVITY);
    expect(consent.refusals).toEqual([]);
  });

  it("does not consult the rule for a call nobody has analysed", async () => {
    /**
     * Ordering, asserted because the obvious implementation gets it wrong in a
     * way nothing else would catch. Deciding consent before checking whether a
     * row exists would put a ledger entry — and a database write — behind every
     * timeline that scrolled past an unanalysed call, drowning the signal a
     * compliance officer is looking for in noise.
     */
    const { db } = makeDb([]);
    const consent = consentStub(REFUSED);

    const found = await new CallAnalysisService(
      db,
      gatewayStub().gateway,
      consent.service,
    ).find(ORG, ACTIVITY);

    expect(found).toBeNull();
    expect(consent.refusals).toEqual([]);
    expect(consent.decide()).not.toHaveBeenCalled();
  });
});
