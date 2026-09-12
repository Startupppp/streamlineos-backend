const forEachOrgMock = jest.fn();
jest.mock("../../../common/tenant", () => ({
  ...jest.requireActual("../../../common/tenant"),
  forEachOrg: (...args: unknown[]) => forEachOrgMock(...args),
}));

import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.types";
import {
  businessParties,
  crmNurtureEnrollments,
  crmNurtureSequenceSteps,
  crmNurtureSequences,
  crmNurtureStepAttempts,
  deals,
  relationshipStates,
} from "../../../db/schema";
import type { ComposeOutcome, OutboundService } from "../outbound.service";
import { MIN_STEP_WAIT_HOURS } from "./nurture-cadence";
import { NurtureSequencesService } from "./nurture-sequences.service";
import { NurtureStepSenderService } from "./nurture-step-sender.service";

type Row = Record<string, unknown>;
type Op = "select" | "update" | "insert" | "delete";
/** Drizzle's table objects, compared by identity — nothing here reads them. */
type Table = unknown;

interface PlannedResult {
  readonly op: Op;
  readonly table: Table;
  readonly rows: Row[];
  readonly error?: Error;
}

interface Written {
  readonly op: Op;
  readonly table: Table;
  readonly values: unknown;
}

/**
 * A database stub keyed on (operation, table) rather than on call order.
 *
 * Order-keyed stubs are what make a query-builder test fail for the wrong
 * reason: adding a projection or reordering two independent reads renames every
 * subsequent expectation, so the suite reports a broken feature when nothing
 * about the behaviour changed. Keying on the table a statement actually names
 * ties each stubbed answer to the thing it is an answer about.
 */
class FakeDb {
  private readonly planned: PlannedResult[] = [];
  readonly written: Written[] = [];
  /** Every table a read touched, in order — how a test counts round trips. */
  readonly reads: Table[] = [];

  plan(op: Op, table: Table, rows: Row[], error?: Error): this {
    this.planned.push({ op, table, rows, error });
    return this;
  }

  private take(op: Op, table: Table): Row[] {
    const index = this.planned.findIndex((p) => p.op === op && p.table === table);
    if (index === -1) return [];
    const [found] = this.planned.splice(index, 1);
    if (found.error) throw found.error;
    return found.rows;
  }

  select(): QueryStub {
    return new QueryStub("select", this, undefined);
  }

  update(table: Table): QueryStub {
    return new QueryStub("update", this, table);
  }

  insert(table: Table): QueryStub {
    return new QueryStub("insert", this, table);
  }

  delete(table: Table): QueryStub {
    return new QueryStub("delete", this, table);
  }

  transaction<T>(fn: (tx: FakeDb) => Promise<T>): Promise<T> {
    // A `jest.fn()` here would swallow every assertion inside the callback.
    return fn(this);
  }

  resolve(op: Op, table: Table): Row[] {
    if (op === "select") this.reads.push(table);
    return this.take(op, table);
  }

  record(op: Op, table: Table, values: unknown): void {
    this.written.push({ op, table, values });
  }

  asDb(): Db {
    return this as unknown as Db;
  }
}

class QueryStub {
  constructor(
    private readonly op: Op,
    private readonly db: FakeDb,
    private table: Table,
  ) {}

  from(table: Table): this {
    this.table = table;
    return this;
  }

  innerJoin(): this {
    return this;
  }

  where(): this {
    return this;
  }

  orderBy(): this {
    return this;
  }

  limit(): this {
    return this;
  }

  groupBy(): this {
    return this;
  }

  returning(): this {
    return this;
  }

  onConflictDoNothing(): this {
    return this;
  }

  set(values: unknown): this {
    this.db.record(this.op, this.table, values);
    return this;
  }

  values(values: unknown): this {
    this.db.record(this.op, this.table, values);
    return this;
  }

  then<T>(onFulfilled: (rows: Row[]) => T): Promise<T> {
    return Promise.resolve(this.db.resolve(this.op, this.table)).then(onFulfilled);
  }
}

const HOUR_MS = 3_600_000;
const ORG = "org_1";
const SEQUENCE = "seq_1";

function activeSequenceRow(overrides: Row = {}): Row {
  return {
    nurtureSequenceId: SEQUENCE,
    name: "Post-demo",
    description: null,
    status: "active",
    createdAt: new Date("2026-08-01T10:00:00Z"),
    updatedAt: new Date("2026-08-01T10:00:00Z"),
    ...overrides,
  };
}

function candidateRow(overrides: Row = {}): Row {
  return {
    nurtureEnrollmentId: "enrol_1",
    nurtureSequenceId: SEQUENCE,
    partyId: "party_1",
    dealId: 42,
    currentStep: 0,
    // Long enough ago that the first step is due under any clamp.
    enrolledAt: new Date(Date.now() - MIN_STEP_WAIT_HOURS * HOUR_MS * 2),
    updatedAt: new Date(Date.now() - MIN_STEP_WAIT_HOURS * HOUR_MS * 2),
    sequenceStatus: "active",
    sequenceDeletedAt: null,
    ...overrides,
  };
}

function stepRow(stepNumber: number): Row {
  return { nurtureSequenceId: SEQUENCE, stepNumber, waitHours: MIN_STEP_WAIT_HOURS };
}

const held = {
  held: true,
  outboundMessageId: "msg_1",
  autonomyHoldId: "hold_1",
  decisionId: "decision_1",
  outboundClass: "nudge",
  holdUntil: new Date(),
  windowSeconds: 900,
} satisfies ComposeOutcome;

function senderWith(
  db: FakeDb,
  composeAndHold: jest.Mock,
): { sender: NurtureStepSenderService; composeAndHold: jest.Mock } {
  const outbound = { composeAndHold } as unknown as OutboundService;
  return { sender: new NurtureStepSenderService(db.asDb(), outbound), composeAndHold };
}

describe("NurtureStepSenderService.runDueStepsForOrg", () => {
  it("leaves a step alone until its wait has elapsed", async () => {
    const db = new FakeDb()
      .plan("select", crmNurtureEnrollments, [
        candidateRow({ enrolledAt: new Date(), updatedAt: new Date() }),
      ])
      .plan("select", crmNurtureSequenceSteps, [stepRow(1)])
      .plan("select", crmNurtureStepAttempts, [])
      .plan("select", relationshipStates, []);

    const composeAndHold = jest.fn();
    const { sender } = senderWith(db, composeAndHold);

    const outcome = await sender.runDueStepsForOrg(ORG);

    expect(outcome).toMatchObject({ considered: 1, waiting: 1, held: 0 });
    expect(composeAndHold).not.toHaveBeenCalled();
  });

  it("claims a due step before composing, and records the hold it produced", async () => {
    const db = new FakeDb()
      .plan("select", crmNurtureEnrollments, [candidateRow()])
      .plan("select", crmNurtureSequenceSteps, [stepRow(1), stepRow(2)])
      .plan("select", crmNurtureStepAttempts, [])
      .plan("select", relationshipStates, [])
      .plan("update", crmNurtureEnrollments, [{ id: "enrol_1" }])
      .plan("insert", crmNurtureStepAttempts, []);

    const composeAndHold = jest.fn().mockResolvedValue(held);
    const { sender } = senderWith(db, composeAndHold);

    const outcome = await sender.runDueStepsForOrg(ORG);

    expect(outcome).toMatchObject({ considered: 1, held: 1, refused: 0, failed: 0 });
    expect(composeAndHold).toHaveBeenCalledWith({
      organizationId: ORG,
      partyId: "party_1",
      // The integer column, as the string every other caller passes.
      dealId: "42",
    });

    // The claim advances `current_step`, and it lands before the attempt row —
    // a compose that never returns must not be able to leave the step claimable.
    expect(db.written.map((w) => w.op)).toEqual(["update", "insert"]);
    expect(db.written[0]?.values).toEqual({ currentStep: 1 });

    expect(db.written[1]?.values).toMatchObject({
      nurtureEnrollmentId: "enrol_1",
      stepNumber: 1,
      outcome: "held",
      outboundMessageId: "msg_1",
      autonomyHoldId: "hold_1",
      reason: null,
    });
  });

  it("records a refusal in the attempt row rather than dropping it", async () => {
    const db = new FakeDb()
      .plan("select", crmNurtureEnrollments, [candidateRow()])
      .plan("select", crmNurtureSequenceSteps, [stepRow(1)])
      .plan("select", crmNurtureStepAttempts, [])
      .plan("select", relationshipStates, [])
      .plan("update", crmNurtureEnrollments, [{ id: "enrol_1" }])
      .plan("insert", crmNurtureStepAttempts, []);

    const composeAndHold = jest.fn().mockResolvedValue({
      held: false,
      stage: "eligibility",
      reason: "They replied recently.",
    } satisfies ComposeOutcome);
    const { sender } = senderWith(db, composeAndHold);

    const outcome = await sender.runDueStepsForOrg(ORG);

    expect(outcome).toMatchObject({ held: 0, refused: 1 });
    expect(db.written.find((w) => w.op === "insert")?.values).toMatchObject({
      outcome: "refused",
      reason: "They replied recently.",
      outboundMessageId: null,
      autonomyHoldId: null,
    });
  });

  it("exits on a reply that landed after enrolment, without paying for a draft", async () => {
    const enrolledAt = new Date(Date.now() - MIN_STEP_WAIT_HOURS * HOUR_MS * 2);

    const db = new FakeDb()
      .plan("select", crmNurtureEnrollments, [candidateRow({ enrolledAt })])
      .plan("select", crmNurtureSequenceSteps, [stepRow(1)])
      .plan("select", crmNurtureStepAttempts, [])
      .plan("select", relationshipStates, [
        { partyId: "party_1", lastInboundAt: new Date(enrolledAt.getTime() + HOUR_MS) },
      ])
      .plan("update", crmNurtureEnrollments, [{ id: "enrol_1" }]);

    const composeAndHold = jest.fn();
    const { sender } = senderWith(db, composeAndHold);

    const outcome = await sender.runDueStepsForOrg(ORG);

    expect(outcome).toMatchObject({ exited: 1, held: 0 });
    expect(composeAndHold).not.toHaveBeenCalled();
    expect(db.written[0]?.values).toMatchObject({ status: "exited", exitReason: "replied" });
  });

  it("exits a paused sequence's enrolments rather than freezing them", async () => {
    const db = new FakeDb()
      .plan("select", crmNurtureEnrollments, [candidateRow({ sequenceStatus: "paused" })])
      .plan("select", crmNurtureSequenceSteps, [stepRow(1)])
      .plan("select", crmNurtureStepAttempts, [])
      .plan("select", relationshipStates, [])
      .plan("update", crmNurtureEnrollments, [{ id: "enrol_1" }]);

    const composeAndHold = jest.fn();
    const { sender } = senderWith(db, composeAndHold);

    const outcome = await sender.runDueStepsForOrg(ORG);

    expect(outcome).toMatchObject({ exited: 1 });
    expect(db.written[0]?.values).toMatchObject({
      status: "exited",
      exitReason: "sequence-paused",
    });
    expect(composeAndHold).not.toHaveBeenCalled();
  });

  it("completes an enrolment that has run out of steps", async () => {
    const db = new FakeDb()
      .plan("select", crmNurtureEnrollments, [candidateRow({ currentStep: 2 })])
      .plan("select", crmNurtureSequenceSteps, [stepRow(1), stepRow(2)])
      .plan("select", crmNurtureStepAttempts, [])
      .plan("select", relationshipStates, [])
      .plan("update", crmNurtureEnrollments, [{ id: "enrol_1" }]);

    const { sender } = senderWith(db, jest.fn());

    const outcome = await sender.runDueStepsForOrg(ORG);

    expect(outcome).toMatchObject({ completed: 1 });
    expect(db.written[0]?.values).toMatchObject({ status: "completed", exitReason: null });
  });

  it("does not compose when another tick already claimed the step", async () => {
    const db = new FakeDb()
      .plan("select", crmNurtureEnrollments, [candidateRow()])
      .plan("select", crmNurtureSequenceSteps, [stepRow(1)])
      .plan("select", crmNurtureStepAttempts, [])
      .plan("select", relationshipStates, [])
      // The conditional advance matched nothing: somebody else got there first.
      .plan("update", crmNurtureEnrollments, []);

    const composeAndHold = jest.fn();
    const { sender } = senderWith(db, composeAndHold);

    const outcome = await sender.runDueStepsForOrg(ORG);

    expect(composeAndHold).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ held: 0, refused: 0, failed: 0 });
  });

  it("stops at the send cap, however many steps are due", async () => {
    const db = new FakeDb()
      .plan("select", crmNurtureEnrollments, [
        candidateRow({ nurtureEnrollmentId: "enrol_1", partyId: "party_1" }),
        candidateRow({ nurtureEnrollmentId: "enrol_2", partyId: "party_2" }),
      ])
      .plan("select", crmNurtureSequenceSteps, [stepRow(1)])
      .plan("select", crmNurtureStepAttempts, [])
      .plan("select", relationshipStates, [])
      .plan("update", crmNurtureEnrollments, [{ id: "enrol_1" }])
      .plan("insert", crmNurtureStepAttempts, []);

    const composeAndHold = jest.fn().mockResolvedValue(held);
    const { sender } = senderWith(db, composeAndHold);

    const outcome = await sender.runDueStepsForOrg(ORG, { maxSends: 1 });

    expect(composeAndHold).toHaveBeenCalledTimes(1);
    // The second is reported as deferred rather than quietly folded into
    // `waiting`, which would say it was not due when it was.
    expect(outcome).toMatchObject({ considered: 2, held: 1, deferred: 1, waiting: 0 });
  });

  it("leaves the step claimed when the compose throws, rather than retrying it", async () => {
    const db = new FakeDb()
      .plan("select", crmNurtureEnrollments, [candidateRow()])
      .plan("select", crmNurtureSequenceSteps, [stepRow(1)])
      .plan("select", crmNurtureStepAttempts, [])
      .plan("select", relationshipStates, [])
      .plan("update", crmNurtureEnrollments, [{ id: "enrol_1" }]);

    const composeAndHold = jest.fn().mockRejectedValue(new Error("provider unreachable"));
    const { sender } = senderWith(db, composeAndHold);

    const outcome = await sender.runDueStepsForOrg(ORG);

    expect(outcome).toMatchObject({ failed: 1, held: 0, refused: 0 });
    // The claim stands and no attempt row was written: a step is skipped, never
    // repeated, because only the repeat is unrecallable.
    expect(db.written.map((w) => w.op)).toEqual(["update"]);
    expect(db.written[0]?.values).toEqual({ currentStep: 1 });
  });

  it("measures the wait from the last attempt, not from enrolment", async () => {
    const db = new FakeDb()
      .plan("select", crmNurtureEnrollments, [candidateRow({ currentStep: 1 })])
      .plan("select", crmNurtureSequenceSteps, [stepRow(1), stepRow(2)])
      // Step 1 was attempted a moment ago, so step 2 is not due yet even though
      // the enrolment itself is old.
      .plan("select", crmNurtureStepAttempts, [
        { nurtureEnrollmentId: "enrol_1", lastAt: new Date() },
      ])
      .plan("select", relationshipStates, []);

    const composeAndHold = jest.fn();
    const { sender } = senderWith(db, composeAndHold);

    const outcome = await sender.runDueStepsForOrg(ORG);

    expect(outcome).toMatchObject({ waiting: 1 });
    expect(composeAndHold).not.toHaveBeenCalled();
  });
});

describe("NurtureSequencesService", () => {
  it("refuses to enrol anybody in a sequence that is not active", async () => {
    const db = new FakeDb().plan("select", crmNurtureSequences, [
      activeSequenceRow({ status: "draft" }),
    ]);

    const service = new NurtureSequencesService(db.asDb());

    await expect(service.enrol(ORG, SEQUENCE, "user_1", { partyId: "party_1" })).rejects.toThrow(
      BadRequestException,
    );
  });

  it("refuses to enrol anybody in a sequence with no steps", async () => {
    const db = new FakeDb()
      .plan("select", crmNurtureSequences, [activeSequenceRow()])
      .plan("select", crmNurtureSequenceSteps, []);

    const service = new NurtureSequencesService(db.asDb());

    await expect(service.enrol(ORG, SEQUENCE, "user_1", { partyId: "party_1" })).rejects.toThrow(
      /no steps/i,
    );
  });

  it("reports a second live enrolment for the same party as a conflict", async () => {
    const duplicate = new Error("insert failed");
    (duplicate as Error & { cause?: unknown }).cause = { code: "23505" };

    const db = new FakeDb()
      .plan("select", crmNurtureSequences, [activeSequenceRow()])
      .plan("select", crmNurtureSequenceSteps, [{ nurtureSequenceId: SEQUENCE, steps: 2 }])
      .plan("select", businessParties, [{ partyId: "party_1" }])
      .plan("select", deals, [{ id: 42 }])
      .plan("insert", crmNurtureEnrollments, [], duplicate);

    const service = new NurtureSequencesService(db.asDb());

    await expect(
      service.enrol(ORG, SEQUENCE, "user_1", { partyId: "party_1", dealId: "42" }),
    ).rejects.toThrow(ConflictException);
  });

  it("refuses to activate a sequence that has no steps to run", async () => {
    const db = new FakeDb()
      .plan("select", crmNurtureSequences, [activeSequenceRow({ status: "draft" })])
      .plan("select", crmNurtureSequenceSteps, []);

    const service = new NurtureSequencesService(db.asDb());

    await expect(service.update(ORG, SEQUENCE, { status: "active" })).rejects.toThrow(
      BadRequestException,
    );
  });

  it("raises the stored wait to the floor a step can actually send at", async () => {
    const db = new FakeDb()
      .plan("select", crmNurtureSequences, [activeSequenceRow()])
      .plan("delete", crmNurtureSequenceSteps, [])
      .plan("insert", crmNurtureSequenceSteps, [
        { nurtureStepId: "step_1", stepNumber: 1, waitHours: MIN_STEP_WAIT_HOURS },
      ]);

    const service = new NurtureSequencesService(db.asDb());

    await service.replaceSteps(ORG, SEQUENCE, { steps: [{ waitHours: 24 }] });

    const inserted = db.written.find((w) => w.op === "insert")?.values as Row[];
    expect(inserted[0]).toMatchObject({ stepNumber: 1, waitHours: MIN_STEP_WAIT_HOURS });
  });

  it("will not overwrite an exit reason somebody else already established", async () => {
    // The conditional update matched nothing: this enrolment has already stopped.
    const db = new FakeDb().plan("update", crmNurtureEnrollments, []);

    const service = new NurtureSequencesService(db.asDb());

    await expect(service.unenrol(ORG, SEQUENCE, "enrol_1")).rejects.toThrow(NotFoundException);
  });

  it("lets go of the people a deleted sequence was holding", async () => {
    const db = new FakeDb()
      .plan("select", crmNurtureSequences, [activeSequenceRow()])
      .plan("update", crmNurtureSequences, [{ id: SEQUENCE }])
      .plan("update", crmNurtureEnrollments, [{ id: "enrol_1" }, { id: "enrol_2" }]);

    const service = new NurtureSequencesService(db.asDb());

    const result = await service.remove(ORG, SEQUENCE);

    expect(result).toEqual({ deleted: true, exitedEnrollments: 2 });
    expect(db.written.find((w) => w.table === crmNurtureEnrollments)?.values).toMatchObject({
      status: "exited",
      exitReason: "sequence-deleted",
    });
  });
});

/**
 * The sweep the cron endpoint actually calls.
 *
 * Every other test here exercises `runDueStepsForOrg`, one organisation at a
 * time. Nothing covered the wrapper — which is where a real defect sat: the
 * per-organisation `failed` count was spread into the result and then
 * overwritten by `forEachOrg`'s own failure count, so a sweep whose every
 * compose threw reported zero failures. Two different things must not share one
 * name in an operator's only view of an unattended loop.
 */
describe("sweeping every organisation", () => {
  const sender = () =>
    new NurtureStepSenderService(new FakeDb().asDb(), {} as unknown as OutboundService);

  it("reports failed steps and failed organisations as separate numbers", async () => {
    forEachOrgMock.mockImplementation(async (_db, _sweep, fn) => {
      await fn({} as never, ORG);
      // Deliberately different numbers: equal ones cannot tell an overwrite
      // from a correct assignment, which is how the defect survived review.
      return { succeeded: 3, failed: 7 };
    });

    const service = sender();
    jest
      .spyOn(service, "runDueStepsForOrg")
      .mockResolvedValue({
        considered: 4,
        waiting: 1,
        deferred: 0,
        held: 1,
        refused: 0,
        exited: 0,
        completed: 0,
        failed: 2,
      });

    const outcome = await service.sweepDueSteps();

    // The two numbers survive together, and neither is the other.
    expect(outcome.failed).toBe(2);
    expect(outcome.organizationsFailed).toBe(7);
    expect(outcome.organizations).toBe(3);
    expect(outcome.held).toBe(1);
  });

  it("totals each organisation's counts rather than reporting the last one", async () => {
    forEachOrgMock.mockImplementation(async (_db, _sweep, fn) => {
      await fn({} as never, "org_a");
      await fn({} as never, "org_b");
      return { succeeded: 2, failed: 0 };
    });

    const service = sender();
    jest
      .spyOn(service, "runDueStepsForOrg")
      .mockResolvedValue({
        considered: 5,
        waiting: 2,
        deferred: 1,
        held: 1,
        refused: 1,
        exited: 0,
        completed: 0,
        failed: 0,
      });

    const outcome = await service.sweepDueSteps();

    expect(outcome).toMatchObject({ considered: 10, waiting: 4, deferred: 2, held: 2, refused: 2 });
  });

  /** A sweep runs with no ambient tenant context, so it must open one per org. */
  it("goes through forEachOrg under its own sweep name", async () => {
    forEachOrgMock.mockResolvedValue({ succeeded: 0, failed: 0 });

    await sender().sweepDueSteps();

    expect(forEachOrgMock).toHaveBeenCalledWith(
      expect.anything(),
      "crm-nurture-steps",
      expect.any(Function),
    );
  });
});

/**
 * Names, resolved where the ids are.
 *
 * The enrolment row stores a party uuid and a deal integer, and a screen may not
 * render either. Returning the ids alone forces the caller into one request per
 * row — or a first-page lookup that reads "a customer you can't see" for
 * everybody further down the list, which is the shape the first version of the
 * UI had to take. Both are the caller paying for a join the server can do once.
 */
describe("enrolment names", () => {
  it("resolves the whole page's names in one lookup each, not one per row", async () => {
    const db = new FakeDb()
      .plan("select", crmNurtureSequences, [activeSequenceRow()])
      .plan("select", crmNurtureEnrollments, [
        {
          nurtureEnrollmentId: "enrol_1",
          nurtureSequenceId: SEQUENCE,
          partyId: "party_a",
          dealId: 11,
          status: "active",
          currentStep: 0,
          exitReason: null,
          exitedAt: null,
          enrolledAt: new Date("2026-01-02T00:00:00Z"),
        },
        {
          nurtureEnrollmentId: "enrol_2",
          nurtureSequenceId: SEQUENCE,
          partyId: "party_b",
          dealId: null,
          status: "active",
          currentStep: 1,
          exitReason: null,
          exitedAt: null,
          enrolledAt: new Date("2026-01-01T00:00:00Z"),
        },
      ])
      .plan("select", businessParties, [
        { partyId: "party_a", name: "Acme Industrial" },
        { partyId: "party_b", name: "Borden Ltd" },
      ])
      .plan("select", deals, [{ id: 11, name: "Acme Q3 renewal" }]);

    const service = new NurtureSequencesService(db.asDb());

    const page = await service.listEnrollments(ORG, SEQUENCE, { limit: 25 });

    expect(page.data[0]).toMatchObject({ partyName: "Acme Industrial", dealName: "Acme Q3 renewal" });
    // No deal on the second, and a null name rather than a borrowed one.
    expect(page.data[1]).toMatchObject({ partyName: "Borden Ltd", dealName: null });

    // Two reads for two rows, and they would still be two for two hundred.
    expect(db.reads.filter((table) => table === businessParties)).toHaveLength(1);
    expect(db.reads.filter((table) => table === deals)).toHaveLength(1);
  });

  it("reports a party that has gone as unnamed rather than as its id", async () => {
    const db = new FakeDb()
      .plan("select", crmNurtureSequences, [activeSequenceRow()])
      .plan("select", crmNurtureEnrollments, [
        {
          nurtureEnrollmentId: "enrol_1",
          nurtureSequenceId: SEQUENCE,
          partyId: "party_gone",
          dealId: null,
          status: "exited",
          currentStep: 2,
          exitReason: "party-deleted",
          exitedAt: new Date("2026-02-01T00:00:00Z"),
          enrolledAt: new Date("2026-01-01T00:00:00Z"),
        },
      ])
      .plan("select", businessParties, [])
      .plan("select", deals, []);

    const service = new NurtureSequencesService(db.asDb());

    const page = await service.listEnrollments(ORG, SEQUENCE, { limit: 25 });

    expect(page.data[0]!.partyName).toBeNull();
  });
});
