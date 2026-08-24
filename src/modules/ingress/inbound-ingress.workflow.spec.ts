import { createStepContext } from "../../common/workflow/step-context";
import type { RecordedStep, WorkflowStepStore } from "../../common/workflow/workflow.types";
import { WorkflowRegistry } from "../../common/workflow";
import type { Db } from "../../db/drizzle.types";
import {
  activities,
  activityParticipants,
  businessParties,
  inboundEvents,
} from "../../db/schema";
import { InboundIngressWorkflow } from "./inbound-ingress.workflow";
import type { InboundCommunicationEvent } from "./inbound-event";

/**
 * The whole path, driven from a fixture.
 *
 * No provider SDK is mocked here, and none exists to mock — that is the point of
 * the seam. What is substituted is the database and the step store, so the test
 * asserts what the pipeline *does* (matches or creates a party, logs one
 * activity as the system, records participants, closes the receipt) and what it
 * does *again* on a retry, which is nothing.
 */

function memoryStore(initial: RecordedStep[] = []): WorkflowStepStore & { rows: RecordedStep[] } {
  const rows = [...initial];
  return {
    rows,
    loadSteps: async () => rows,
    recordStep: async (step) => {
      const existing = rows.findIndex((row) => row.stepName === step.stepName);
      const row: RecordedStep = {
        stepName: step.stepName,
        status: step.status,
        output: step.output,
      };
      if (existing >= 0) rows[existing] = row;
      else rows.push(row);
    },
  };
}

const FIXTURE: InboundCommunicationEvent = {
  organizationId: "org-1",
  channel: "email",
  provider: "fixture",
  providerMessageId: "msg-1",
  providerThreadId: "thread-1",
  occurredAt: "2026-08-23T10:00:00.000Z",
  subject: "Quote for Q3",
  body: "Can you send the quote?",
  participants: [
    { address: "Priya@Example.com", displayName: "Priya Raman", role: "from" },
    { address: "sales@acme-crm.test", role: "to" },
  ],
};

interface Recorder {
  inserts: Array<{ table: string; rows: Record<string, unknown>[] }>;
  updates: Record<string, unknown>[];
}

/**
 * Identifies the target table by object identity.
 *
 * Drizzle keeps a table's SQL name behind a symbol rather than a plain property,
 * so reading `_.name` silently yields undefined and every assertion passes
 * vacuously. Comparing against the imported objects cannot drift.
 */
function tableName(table: unknown): string {
  if (table === businessParties) return "business_parties";
  if (table === activities) return "activities";
  if (table === activityParticipants) return "activity_participants";
  if (table === inboundEvents) return "inbound_events";
  return "unknown";
}

/**
 * A database stand-in that answers the four reads the workflow makes and records
 * every write, so the assertions are about behaviour rather than about SQL.
 */
function makeDb(recorder: Recorder, existingParty: string | null): Db {
  let selectCall = 0;

  return {
    select: jest.fn().mockImplementation(() => ({
      from: jest.fn().mockImplementation(() => ({
        where: jest.fn().mockImplementation(() => ({
          limit: jest.fn().mockImplementation(async () => {
            selectCall += 1;
            // First read: the receipt's payload. Second: an existing party.
            if (selectCall === 1) return [{ payload: FIXTURE }];
            return existingParty ? [{ partyId: existingParty }] : [];
          }),
        })),
      })),
    })),
    insert: jest.fn().mockImplementation((table: unknown) => ({
      values: jest.fn().mockImplementation((rows: unknown) => {
        recorder.inserts.push({
          table: tableName(table),
          rows: (Array.isArray(rows) ? rows : [rows]) as Record<string, unknown>[],
        });
        return {
          returning: jest.fn().mockResolvedValue([
            { partyId: "party-new", activityId: "activity-new" },
          ]),
        };
      }),
    })),
    update: jest.fn().mockImplementation(() => ({
      set: jest.fn().mockImplementation((values: Record<string, unknown>) => {
        recorder.updates.push(values);
        return { where: jest.fn().mockResolvedValue(undefined) };
      }),
    })),
  } as unknown as Db;
}

async function runWorkflow(db: Db, store: WorkflowStepStore): Promise<void> {
  const registry = new WorkflowRegistry();
  const workflow = new InboundIngressWorkflow(db, registry);
  workflow.onModuleInit();

  const definition = registry.get("crm.inbound-communication");
  if (!definition) throw new Error("workflow was not registered");

  const step = await createStepContext({
    runId: "run-1",
    organizationId: "org-1",
    attempt: 0,
    store,
  });

  await definition.handler(step, {
    runId: "run-1",
    organizationId: "org-1",
    attempt: 0,
    input: { inboundEventId: "receipt-1" },
  });
}

function insertsInto(recorder: Recorder, table: string): Record<string, unknown>[] {
  return recorder.inserts.filter((entry) => entry.table === table).flatMap((entry) => entry.rows);
}

describe("inbound ingress, end to end from a fixture", () => {
  it("registers itself, so a run is not dead-lettered for want of a handler", () => {
    const registry = new WorkflowRegistry();
    new InboundIngressWorkflow(makeDb({ inserts: [], updates: [] }, null), registry).onModuleInit();
    expect(registry.names).toContain("crm.inbound-communication");
  });

  it("creates a party for a sender the CRM has never seen", async () => {
    const recorder: Recorder = { inserts: [], updates: [] };
    await runWorkflow(makeDb(recorder, null), memoryStore());

    const parties = insertsInto(recorder, "business_parties");
    expect(parties).toHaveLength(1);
    expect(parties[0]).toMatchObject({
      organizationId: "org-1",
      name: "Priya Raman",
      // Normalised, so the same person does not become three parties.
      email: "priya@example.com",
    });
  });

  it("matches a sender it already knows without creating a duplicate", async () => {
    const recorder: Recorder = { inserts: [], updates: [] };
    await runWorkflow(makeDb(recorder, "party-existing"), memoryStore());

    expect(insertsInto(recorder, "business_parties")).toHaveLength(0);
    expect(insertsInto(recorder, "activities")[0]).toMatchObject({ partyId: "party-existing" });
  });

  it("logs exactly one activity, attributed to the system rather than a person", async () => {
    const recorder: Recorder = { inserts: [], updates: [] };
    await runWorkflow(makeDb(recorder, null), memoryStore());

    const logged = insertsInto(recorder, "activities");
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      kind: "email",
      subject: "Quote for Q3",
      threadId: "thread-1",
      actorKind: "system",
      actorLabel: "ingress:email",
    });
    // Nobody typed it, so it borrows nobody's identity — the CHECK constraint
    // refuses a system row carrying a user id, and this is the code side of that.
    expect(logged[0]?.actorUserId).toBeUndefined();
  });

  it("records the external participants on the activity", async () => {
    const recorder: Recorder = { inserts: [], updates: [] };
    await runWorkflow(makeDb(recorder, null), memoryStore());

    const participants = insertsInto(recorder, "activity_participants");
    expect(participants.map((row) => row.address)).toEqual(
      expect.arrayContaining(["priya@example.com", "sales@acme-crm.test"]),
    );
  });

  it("closes the receipt so a later delivery is recognised as a duplicate", async () => {
    const recorder: Recorder = { inserts: [], updates: [] };
    await runWorkflow(makeDb(recorder, null), memoryStore());

    expect(recorder.updates.at(-1)).toMatchObject({ status: "PROCESSED" });
  });

  /**
   * The property the whole durable runtime exists for.
   *
   * A retry re-executes the workflow body from the top. If the steps were not
   * memoised, the second attempt would create a second party and a second
   * activity for one message — which is the exact failure the ticket's
   * exactly-once criterion is about.
   */
  it("does nothing a second time when the run is retried", async () => {
    const store = memoryStore();

    const first: Recorder = { inserts: [], updates: [] };
    await runWorkflow(makeDb(first, null), store);

    const second: Recorder = { inserts: [], updates: [] };
    await runWorkflow(makeDb(second, null), store);

    expect(first.inserts.length).toBeGreaterThan(0);
    expect(second.inserts).toHaveLength(0);
    expect(second.updates).toHaveLength(0);
  });

  it("records each stage as its own step, so a stuck delivery says where it stopped", async () => {
    const store = memoryStore();
    await runWorkflow(makeDb({ inserts: [], updates: [] }, null), store);

    expect(store.rows.map((row) => row.stepName)).toEqual([
      "resolve-region",
      "resolve-party",
      "log-activity",
      "record-participants",
      // Ticket 12's inference is its own step so a provider failure retries the
      // reasoning without re-creating the party and activity beneath it.
      "extract-and-act",
      "mark-processed",
    ]);
  });
});
