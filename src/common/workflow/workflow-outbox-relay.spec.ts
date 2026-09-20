import type { Db } from "../../db/drizzle.types";
import type { TenantTx } from "../tenant";
import { WorkflowRegistry } from "./workflow-registry";
import { WorkflowOutboxRelayService } from "./workflow-outbox-relay.service";
import type { WorkflowRunnerService } from "./workflow-runner.service";

const mockForEachOrg = jest.fn();

jest.mock("../tenant", () => ({
  forEachOrg: (...args: unknown[]) => mockForEachOrg(...args),
}));

interface EventRow {
  outboxEventId: number;
  eventId: string;
  organizationId: string;
  eventType: string;
  payload: Record<string, unknown>;
  correlationId: string | null;
}

/**
 * Drives the relay one batch per `relay()` call, through `forEachOrg`.
 *
 * The relay no longer issues one cross-tenant select — that form is denied under
 * RLS, which is the defect these tests now sit on top of. It sweeps
 * organisations and reads each one's outbox inside that organisation's
 * transaction, so the double has to do the same: group the batch by
 * organisation and hand each group to the callback under its own org id.
 */
function dbReturning(batches: EventRow[][]): Db {
  const queue = [...batches];

  mockForEachOrg.mockImplementation(
    async (_db: unknown, _sweep: string, fn: (tx: TenantTx, orgId: string) => Promise<void>) => {
      const batch = queue.shift() ?? [];
      const byOrg = new Map<string, EventRow[]>();
      for (const row of batch) {
        const rows = byOrg.get(row.organizationId) ?? [];
        rows.push(row);
        byOrg.set(row.organizationId, rows);
      }
      // An organisation is swept even with nothing to read, exactly as the real one is.
      if (byOrg.size === 0) byOrg.set("org-1", []);

      for (const [orgId, rows] of byOrg) {
        const chain = {
          from: () => chain,
          where: () => chain,
          orderBy: () => chain,
          limit: async () => rows,
        };
        await fn({ select: () => chain } as unknown as TenantTx, orgId);
      }
      return { organizations: byOrg.size, succeeded: byOrg.size, failed: 0 };
    },
  );

  return { select: () => undefined } as unknown as Db;
}

beforeEach(() => {
  jest.clearAllMocks();
});

function runnerSpy(behaviour?: (name: string) => Promise<string | null>) {
  const started: { workflowName: string; causationEventId?: string | null }[] = [];
  const service = {
    start: async (input: {
      workflowName: string;
      causationEventId?: string | null;
    }): Promise<string | null> => {
      started.push(input);
      return behaviour ? behaviour(input.workflowName) : "run-1";
    },
  } as unknown as WorkflowRunnerService;
  return { service, started };
}

function event(overrides: Partial<EventRow> = {}): EventRow {
  return {
    outboxEventId: 1,
    eventId: "evt-1",
    organizationId: "org-1",
    eventType: "party.created",
    payload: { partyId: "p-1" },
    correlationId: "c-1",
    ...overrides,
  };
}

describe("WorkflowOutboxRelayService", () => {
  /**
   * The regression this file exists to prevent a second time.
   *
   * A relay that reads the outbox directly works against an owner connection and
   * fails against the non-owner role the application is supposed to use — so the
   * failure appears only in an environment nobody runs unit tests in, and what
   * it looks like there is every durable workflow in the product quietly
   * stopping. Discovery therefore goes through `forEachOrg`, once per tick.
   */
  it("discovers per organisation rather than across tenants", async () => {
    const registry = new WorkflowRegistry();
    const relay = new WorkflowOutboxRelayService(dbReturning([[event()]]), registry, runnerSpy().service);

    await relay.relay();

    expect(mockForEachOrg).toHaveBeenCalledTimes(1);
    expect(mockForEachOrg.mock.calls[0]?.[1]).toBe("workflow-outbox-relay");
  });

  function budgetOf(call: number): (() => boolean) | undefined {
    const options = mockForEachOrg.mock.calls[call]?.[4] as
      | { stopWhen?: () => boolean }
      | undefined;
    return options?.stopWhen;
  }

  it("stops opening tenant transactions once the tick's budget is full", async () => {
    const registry = new WorkflowRegistry();
    const relay = new WorkflowOutboxRelayService(
      dbReturning([[event()]]),
      registry,
      runnerSpy().service,
    );

    await relay.relay(1);

    expect(typeof budgetOf(0)).toBe("function");
    expect(budgetOf(0)?.()).toBe(true);
  });

  it("keeps sweeping while the tick still has budget left", async () => {
    const registry = new WorkflowRegistry();
    const relay = new WorkflowOutboxRelayService(
      dbReturning([[event()]]),
      registry,
      runnerSpy().service,
    );

    await relay.relay(5);

    expect(budgetOf(0)?.()).toBe(false);
  });

  it("starts a run for an event a workflow listens to", async () => {
    const registry = new WorkflowRegistry();
    registry.register({ name: "onboard", triggers: ["party.created"], handler: async () => null });
    const runner = runnerSpy();

    const relay = new WorkflowOutboxRelayService(
      dbReturning([[event()]]),
      registry,
      runner.service,
    );
    const result = await relay.relay();

    expect(result).toEqual({ scanned: 1, started: 1 });
    expect(runner.started[0]).toMatchObject({ workflowName: "onboard" });
  });

  it("ignores an event no workflow listens to", async () => {
    const registry = new WorkflowRegistry();
    registry.register({ name: "onboard", triggers: ["deal.won"], handler: async () => null });
    const runner = runnerSpy();

    const relay = new WorkflowOutboxRelayService(
      dbReturning([[event()]]),
      registry,
      runner.service,
    );
    const result = await relay.relay();

    expect(result).toEqual({ scanned: 1, started: 0 });
    expect(runner.started).toEqual([]);
  });

  it("starts every workflow listening to the same event", async () => {
    const registry = new WorkflowRegistry();
    registry.register({ name: "a", triggers: ["party.created"], handler: async () => null });
    registry.register({ name: "b", triggers: ["party.created"], handler: async () => null });
    const runner = runnerSpy();

    const relay = new WorkflowOutboxRelayService(
      dbReturning([[event()]]),
      registry,
      runner.service,
    );
    await relay.relay();

    expect(runner.started.map((s) => s.workflowName)).toEqual(["a", "b"]);
  });

  it("carries the event id, so a redelivery resumes rather than duplicating", async () => {
    const registry = new WorkflowRegistry();
    registry.register({ name: "onboard", triggers: ["party.created"], handler: async () => null });
    const runner = runnerSpy();

    const relay = new WorkflowOutboxRelayService(
      dbReturning([[event()]]),
      registry,
      runner.service,
    );
    await relay.relay();

    expect(runner.started[0]?.causationEventId).toBe("evt-1");
  });

  it("counts a deduplicated redelivery as scanned but not started", async () => {
    const registry = new WorkflowRegistry();
    registry.register({ name: "onboard", triggers: ["party.created"], handler: async () => null });
    // startRun returns null when the run already exists and cannot be re-read.
    const runner = runnerSpy(async () => null);

    const relay = new WorkflowOutboxRelayService(
      dbReturning([[event()]]),
      registry,
      runner.service,
    );

    expect(await relay.relay()).toEqual({ scanned: 1, started: 0 });
  });

  it("advances past events it has considered", async () => {
    const registry = new WorkflowRegistry();
    registry.register({ name: "onboard", triggers: ["party.created"], handler: async () => null });
    const runner = runnerSpy();

    const relay = new WorkflowOutboxRelayService(
      dbReturning([[event({ outboxEventId: 7 })], []]),
      registry,
      runner.service,
    );

    await relay.relay();
    // Trails the highest id by CURSOR_LAG rather than landing on it, so an event
    // that commits after a higher-numbered neighbour is still read.
    expect(relay.position).toBe(0);

    // Second pass sees nothing new and starts nothing.
    expect(await relay.relay()).toEqual({ scanned: 0, started: 0 });
  });

  it("advances past an event nobody listens to, rather than rescanning it forever", async () => {
    const runner = runnerSpy();
    const relay = new WorkflowOutboxRelayService(
      dbReturning([[event({ outboxEventId: 4 })]]),
      new WorkflowRegistry(),
      runner.service,
    );

    await relay.relay();
    expect(relay.position).toBe(0);
  });

  it("keeps going when one event fails to start, so one tenant cannot stall the rest", async () => {
    const registry = new WorkflowRegistry();
    registry.register({ name: "onboard", triggers: ["party.created"], handler: async () => null });

    const started: string[] = [];
    const runner = {
      start: async (input: { organizationId: string }): Promise<string | null> => {
        if (input.organizationId === "org-bad") throw new Error("insert failed");
        started.push(input.organizationId);
        return "run-1";
      },
    } as unknown as WorkflowRunnerService;

    const relay = new WorkflowOutboxRelayService(
      dbReturning([
        [
          event({ outboxEventId: 1, organizationId: "org-bad" }),
          event({ outboxEventId: 2, organizationId: "org-good", eventId: "evt-2" }),
        ],
      ]),
      registry,
      runner,
    );

    const result = await relay.relay();

    expect(started).toEqual(["org-good"]);
    expect(result.scanned).toBe(2);
    expect(relay.position).toBe(0);
  });

  it("can be rewound, for a replay after a bad deploy", async () => {
    const relay = new WorkflowOutboxRelayService(
      dbReturning([[event({ outboxEventId: 9 })]]),
      new WorkflowRegistry(),
      runnerSpy().service,
    );

    await relay.relay();
    expect(relay.position).toBe(0);

    relay.resetPosition(0);
    expect(relay.position).toBe(0);
  });

  /**
   * The bug the cursor lag exists for.
   *
   * `outbox_event_id` is an identity sequence, and a sequence hands out numbers
   * when a transaction asks rather than when it commits — so ids become visible
   * in commit order. Here the writer holding 5,000 is still open when the relay
   * sees 6,000, and commits afterwards.
   *
   * With a cursor that landed on the highest id seen, the next pass would query
   * `> 6000` and 5,000 would never be read again: its workflow never starts, not
   * late — never. The quote sits in its hold window forever and every screen goes
   * on reporting work in progress.
   */
  it("still reads an event that committed after a higher-numbered one", async () => {
    const registry = new WorkflowRegistry();
    registry.register({ name: "onboard", triggers: ["party.created"], handler: async () => null });
    const runner = runnerSpy();

    const relay = new WorkflowOutboxRelayService(
      dbReturning([
        // First pass: only the later-numbered event is visible.
        [event({ outboxEventId: 6000, eventId: "evt-6000" })],
        // Second pass: the lower-numbered writer has now committed.
        [event({ outboxEventId: 5000, eventId: "evt-5000" })],
      ]),
      registry,
      runner.service,
    );

    await relay.relay();
    await relay.relay();

    expect(runner.started.map((s) => s.causationEventId)).toEqual(["evt-6000", "evt-5000"]);
  });
});
