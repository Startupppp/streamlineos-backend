import type { AiGatewayService } from "../ai/core/gateway/ai-gateway.service";
import type { DealsService } from "../deals/deals.service";
import type { Db } from "../../db/drizzle.types";
import {
  activities,
  autonomousDecisions,
  autonomySwitches,
  crmPipelineStages,
  deals,
} from "../../db/schema";
import { AutonomyService } from "./autonomy.service";
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
  return {
    then: (resolve: (value: T[]) => unknown, reject?: (error: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
    limit: async () => rows,
  };
}

function makeDb(
  rec: Recorder,
  activity: ActivityFixture | null,
  /** One entry per `loadDeal`; the last is reused once exhausted. */
  dealReads: (DealFixture | null)[],
  stages: string[],
): Db {
  let dealRead = 0;

  return {
    select: () => ({
      from: (table: unknown) => {
        if (table === activities)
          return {
            leftJoin: () => ({ where: () => query(activity ? [activity] : []) }),
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

function makeService(
  db: Db,
  result: unknown,
  updateDeal: jest.Mock,
): AutonomyService {
  const gateway = {
    invokeStructuredWithUsage: jest.fn().mockResolvedValue(result),
  } as unknown as AiGatewayService;

  return new AutonomyService(db, gateway, { updateDeal } as unknown as DealsService);
}

const ok = (data: Extraction) => ({ ok: true, data, aiUsage: { model: "fast-1" } });

const REPLY: ActivityFixture = {
  subject: "Re: Q3 pricing",
  body: "That looks good, please send the proposal over and we will sign this week.",
  dealId: "7",
  fromAddress: "priya@example.com",
};

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
      expect(String(rec.decisions[0]?.summary)).toContain("too short");
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
