import type { Db } from "../../db/drizzle.types";
import { WorkflowRegistry } from "./workflow-registry";
import { WorkflowOutboxRelayService } from "./workflow-outbox-relay.service";
import type { WorkflowRunnerService } from "./workflow-runner.service";

interface EventRow {
  outboxEventId: number;
  eventId: string;
  organizationId: string;
  eventType: string;
  payload: Record<string, unknown>;
  correlationId: string | null;
}

function dbReturning(batches: EventRow[][]): Db {
  const queue = [...batches];
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: async () => queue.shift() ?? [],
  };
  return { select: () => chain } as unknown as Db;
}

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
    expect(relay.position).toBe(7);

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
    expect(relay.position).toBe(4);
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
    expect(relay.position).toBe(2);
  });

  it("can be rewound, for a replay after a bad deploy", async () => {
    const relay = new WorkflowOutboxRelayService(
      dbReturning([[event({ outboxEventId: 9 })]]),
      new WorkflowRegistry(),
      runnerSpy().service,
    );

    await relay.relay();
    expect(relay.position).toBe(9);

    relay.resetPosition(0);
    expect(relay.position).toBe(0);
  });
});
