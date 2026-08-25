/**
 * The end of a hold, driven through the real step machinery.
 *
 * Two things here are not ordinary unit-test scaffolding and are the point of
 * the file. `tenantDepth` mirrors what the runner actually gives a workflow —
 * every `step.run` body is wrapped in a tenant transaction and the handler body
 * is NOT — so a query issued outside one is recorded as a violation rather than
 * passing silently the way it does against a database owner with BYPASSRLS. And
 * `events` records step commits and the outbound send in one ordered list, which
 * is the only way to state "the claim was durable before the quote left".
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
import { WorkflowRegistry } from "../../common/workflow";
import type { Db } from "../../db/drizzle.types";
import { autonomousDecisions, autonomyHolds, autonomySwitches } from "../../db/schema";
import type { QuotesLifecycleService } from "../quotes/quotes-lifecycle.service";
import { AutonomyHoldWorkflow } from "./autonomy-hold.workflow";
import { HOLD_WORKFLOW } from "./autonomy-hold.service";

const ORG = "org-1";
const HOLD = "hold-1";
const DECISION = "decision-1";

/** A window that closed a minute ago, unless a test says otherwise. */
const closed = () => new Date(Date.now() - 60_000);

interface Recorder {
  events: string[];
  holdUpdates: Record<string, unknown>[];
  decisionUpdates: Record<string, unknown>[];
  /** Tables read with no tenant transaction around them. Must stay empty. */
  unscopedReads: string[];
  /** Whether the switches read carried a WHERE at all. */
  switchReadFiltered: boolean;
}

const recorder = (): Recorder => ({
  events: [],
  holdUpdates: [],
  decisionUpdates: [],
  unscopedReads: [],
  switchReadFiltered: false,
});

/** Resolves to `rows`, and answers `.limit()` / `.returning()` with the same. */
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
}

function makeDb(
  rec: Recorder,
  hold: HoldFixture | null,
  options: { switchEnabled?: boolean; claimWins?: boolean } = {},
): Db {
  const { switchEnabled = true, claimWins = true } = options;

  const holdRows = hold
    ? [
        {
          status: hold.status,
          holdUntil: hold.holdUntil,
          quoteId: 42,
          decisionId: DECISION,
          sendAsUserId: "user-owner",
        },
      ]
    : [];

  return {
    select: () => ({
      from: (table: unknown) => {
        if (tenantDepth === 0)
          rec.unscopedReads.push(table === autonomySwitches ? "autonomy_switches" : "autonomy_holds");

        if (table === autonomySwitches)
          return {
            where: () => {
              rec.switchReadFiltered = true;
              return query([
                { organizationId: null, kind: "*", enabled: switchEnabled, reason: null },
              ]);
            },
            // Reached only if the call site forgot its WHERE, which is the thing
            // the assertion below is checking for.
            then: (resolve: (value: unknown[]) => unknown) =>
              Promise.resolve([
                { organizationId: null, kind: "*", enabled: switchEnabled, reason: null },
              ]).then(resolve),
          };

        return {
          leftJoin: () => ({ where: () => query(holdRows) }),
          where: () => query(holdRows),
        };
      },
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => {
        if (table === autonomyHolds) rec.holdUpdates.push(values);
        if (table === autonomousDecisions) rec.decisionUpdates.push(values);
        return {
          where: () =>
            query(
              table === autonomyHolds && values.status === "sent" && claimWins
                ? [{ id: HOLD }]
                : table === autonomyHolds && values.status === "sent"
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

/** The window is already slept, which is the state every case below starts in. */
const sleptStep: RecordedStep = {
  stepName: "hold-window",
  status: "COMPLETED",
  output: { wakeAt: new Date().toISOString() },
};

async function run(
  db: Db,
  send: jest.Mock,
  store: ReturnType<typeof memoryStore>,
): Promise<void> {
  const registry = new WorkflowRegistry();
  const workflow = new AutonomyHoldWorkflow(
    db,
    registry,
    { send } as unknown as QuotesLifecycleService,
  );
  workflow.onModuleInit();

  const definition = registry.get(HOLD_WORKFLOW);
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

  await definition.handler(step, {
    runId: "run-1",
    organizationId: ORG,
    attempt: 0,
    input: { autonomyHoldId: HOLD },
  });
}

beforeEach(() => {
  tenantDepth = 0;
});

describe("the hold workflow", () => {
  it("registers itself, so a run is not dead-lettered for want of a handler", () => {
    const registry = new WorkflowRegistry();
    new AutonomyHoldWorkflow(
      makeDb(recorder(), { status: "held", holdUntil: closed() }),
      registry,
      { send: jest.fn() } as unknown as QuotesLifecycleService,
    ).onModuleInit();
    expect(registry.names).toContain(HOLD_WORKFLOW);
  });

  /**
   * The first read happens before the first step, so it has no tenant
   * transaction unless it opens one. `autonomy_holds` has a NOT NULL tenant
   * column, so its policy still calls the raising `app.current_org_id()` — a
   * context-less read is 42501, five retries and a dead-lettered run whose quote
   * never sends. Invisible in dev, where the connection owns the database.
   */
  it("never reads outside a tenant transaction", async () => {
    const rec = recorder();
    const send = jest.fn().mockResolvedValue({ id: 42, status: "SENT" });

    await run(makeDb(rec, { status: "held", holdUntil: closed() }), send, memoryStore([sleptStep], rec));

    expect(rec.unscopedReads).toEqual([]);
  });

  /**
   * The claim and the send are two transactions, or "sends exactly once" is not
   * true. In one step, a pod killed — or an idle-in-transaction timeout fired —
   * between `send()` and COMMIT rolls the claim back to `held`, the lease
   * expires, the run is re-claimed, and the customer gets the quote twice.
   */
  it("commits the held→sent claim before the quote leaves", async () => {
    const rec = recorder();
    const send = jest.fn().mockImplementation(async () => {
      rec.events.push("send");
      return { id: 42, status: "SENT" };
    });

    await run(makeDb(rec, { status: "held", holdUntil: closed() }), send, memoryStore([sleptStep], rec));

    expect(rec.events).toEqual(["commit:claim-send", "send", "commit:perform-send"]);
    expect(rec.decisionUpdates).toEqual([{ outcome: "applied" }]);
  });

  it("does not claim a second time when only the send is retried", async () => {
    const rec = recorder();
    const send = jest.fn().mockResolvedValue({ id: 42, status: "SENT" });

    const store = memoryStore(
      [
        sleptStep,
        {
          stepName: "claim-send",
          status: "COMPLETED",
          output: {
            outcome: "claimed",
            quoteId: 42,
            decisionId: DECISION,
            sendAsUserId: "user-owner",
          },
        },
      ],
      rec,
    );

    await run(makeDb(rec, { status: "sent", holdUntil: closed() }), send, store);

    expect(send).toHaveBeenCalledTimes(1);
    // Nothing moved the hold again: the only writes are the ones the send made.
    expect(rec.holdUpdates).toEqual([]);
  });

  /**
   * `send` does not throw on its two likeliest failures. The workflow used to
   * discard the return value and write `applied` regardless, so the deal owner
   * who read the "about to send" notification and sent the quote himself was
   * recorded as the system's send — crediting his work to the machine and
   * padding the denominator the correction rate is measured against.
   */
  describe("a send that did not happen is not recorded as one", () => {
    it("treats not_draft as a failure, not an application", async () => {
      const rec = recorder();
      const send = jest.fn().mockResolvedValue({ error: "not_draft" });

      await run(
        makeDb(rec, { status: "held", holdUntil: closed() }),
        send,
        memoryStore([sleptStep], rec),
      );

      expect(rec.decisionUpdates).toEqual([{ outcome: "failed" }]);
      expect(rec.holdUpdates).toEqual([
        { status: "sent", sentAt: expect.any(Date) },
        { status: "failed", sentAt: null },
      ]);
    });

    it("treats a vanished quote as a failure", async () => {
      const rec = recorder();
      const send = jest.fn().mockResolvedValue(null);

      await run(
        makeDb(rec, { status: "held", holdUntil: closed() }),
        send,
        memoryStore([sleptStep], rec),
      );

      expect(rec.decisionUpdates).toEqual([{ outcome: "failed" }]);
    });

    it("still records a thrown send as a failure", async () => {
      const rec = recorder();
      const send = jest.fn().mockRejectedValue(new Error("smtp refused it"));

      await run(
        makeDb(rec, { status: "held", holdUntil: closed() }),
        send,
        memoryStore([sleptStep], rec),
      );

      expect(rec.decisionUpdates).toEqual([{ outcome: "failed" }]);
    });
  });

  it("does not send a hold whose window has not run out", async () => {
    const rec = recorder();
    const send = jest.fn();
    const stillWaiting = new Date(Date.now() + 5 * 60_000);

    await run(
      makeDb(rec, { status: "held", holdUntil: stillWaiting }),
      send,
      memoryStore([sleptStep], rec),
    );

    expect(send).not.toHaveBeenCalled();
    expect(rec.holdUpdates).toEqual([]);
  });

  it("cancels rather than sends when the switch went off during the window", async () => {
    const rec = recorder();
    const send = jest.fn();

    await run(
      makeDb(rec, { status: "held", holdUntil: closed() }, { switchEnabled: false }),
      send,
      memoryStore([sleptStep], rec),
    );

    expect(send).not.toHaveBeenCalled();
    expect(rec.holdUpdates[0]).toMatchObject({ status: "cancelled" });
    expect(rec.decisionUpdates[0]).toMatchObject({ outcome: "reversed" });
  });

  it("does not send when the claim found no held row", async () => {
    const rec = recorder();
    const send = jest.fn();

    await run(
      makeDb(rec, { status: "held", holdUntil: closed() }, { claimWins: false }),
      send,
      memoryStore([sleptStep], rec),
    );

    expect(send).not.toHaveBeenCalled();
  });

  /**
   * Not a leak — `switchesFor` drops foreign rows in JS and RLS drops them in
   * production — but an unscoped read pulls every tenant's switches back on
   * every hold expiry, and both sibling call sites already filter.
   */
  it("reads only the switches that govern this organisation", async () => {
    const rec = recorder();
    const send = jest.fn().mockResolvedValue({ id: 42, status: "SENT" });

    await run(makeDb(rec, { status: "held", holdUntil: closed() }), send, memoryStore([sleptStep], rec));

    expect(rec.switchReadFiltered).toBe(true);
  });
});
