/**
 * The tenant transaction is substituted, and recorded.
 *
 * A workflow body gets no ambient tenant context, so the receipt has to be read
 * inside one it opens itself — otherwise the query falls through to the raw
 * pool with no `app.organization_id`, and an RLS policy on a NOT NULL tenant
 * column raises 42501. Dev never sees it because `DATABASE_URL` connects as an
 * owner with BYPASSRLS, so the only place this can be held is here.
 */
const mockTenantTransactions: string[] = [];
jest.mock("../../common/tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: (db: unknown, orgId: string, fn: (tx: unknown) => Promise<unknown>) => {
    mockTenantTransactions.push(orgId);
    return fn(db);
  },
}));

import { createStepContext } from "../../common/workflow/step-context";
import type { RecordedStep, WorkflowStepStore } from "../../common/workflow/workflow.types";
import { WorkflowRegistry } from "../../common/workflow";
import type { Db } from "../../db/drizzle.types";
import {
  activities,
  activityParticipants,
  autonomousDecisions,
  businessParties,
  inboundEvents,
  partyIdentifiers,
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
  if (table === partyIdentifiers) return "party_identifiers";
  if (table === autonomousDecisions) return "autonomous_decisions";
  return "unknown";
}

/**
 * A database stand-in that answers the four reads the workflow makes and records
 * every write, so the assertions are about behaviour rather than about SQL.
 */
function makeDb(
  recorder: Recorder,
  existingParty: string | null,
  payload = FIXTURE,
  liveParties = 0,
): Db {
  let selectCall = 0;

  return {
    select: jest.fn().mockImplementation(() => ({
      from: jest.fn().mockImplementation(() => ({
        /**
         * Two shapes of read, told apart by whether the caller narrows.
         *
         * Every read this workflow made until ticket 07 ended in `.limit(1)`.
         * The plan-limit count does not — it is an aggregate over the whole
         * tenant — so it awaits the builder straight off `where`. Making the
         * return value both thenable and `.limit()`-able answers both without
         * the harness having to guess which one it is looking at.
         */
        where: jest.fn().mockImplementation(() => ({
          then: (resolve: (rows: unknown) => unknown) =>
            Promise.resolve([{ current: liveParties }]).then(resolve),
          limit: jest.fn().mockImplementation(async () => {
            selectCall += 1;
            // First read: the receipt's payload. Second: the sender's identifier.
            // Third: whether the party holding it is still live.
            if (selectCall === 1) return [{ payload }];
            if (selectCall === 2)
              return existingParty
                ? [{ partyIdentifierId: "identifier-1", partyId: existingParty }]
                : [];
            return existingParty ? [{ deletedAt: null }] : [];
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
          // An identifier claim tolerates a value another party already holds:
          // losing the claim leaves a duplicate to merge, which is recoverable.
          onConflictDoNothing: jest.fn().mockResolvedValue([]),
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

/**
 * A call, which is the channel that could not be filed at all before ticket 22.
 *
 * Every caller is a telephone number, and the resolver used to compare the
 * sender against `business_parties.email` — so a phone number was written into
 * the email column, and the same person's next email did not match it.
 */
const CALL_FIXTURE: InboundCommunicationEvent = {
  organizationId: "org-1",
  channel: "call",
  provider: "fixture-telephony",
  providerMessageId: "call-1",
  providerThreadId: "call-thread-1",
  occurredAt: "2026-08-23T11:00:00.000Z",
  subject: null,
  body: null,
  participants: [
    {
      address: "+1 (415) 555-1212",
      displayName: "Priya Raman",
      role: "from",
      identifierKind: "phone",
    },
    { address: "+14155559000", role: "to", identifierKind: "phone" },
  ],
};

async function runWorkflow(
  db: Db,
  store: WorkflowStepStore,
  planLimits?: { limitFor: (orgId: string, key: string) => Promise<number | null> },
): Promise<void> {
  const registry = new WorkflowRegistry();
  const workflow = new InboundIngressWorkflow(
    db,
    registry,
    undefined,
    undefined,
    planLimits as never,
  );
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
  beforeEach(() => {
    mockTenantTransactions.length = 0;
  });

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

  /**
   * The claim, written with the party rather than after it.
   *
   * A party created with no identifier is one the sender's next message will
   * not match, so they would become a second record — which is the failure the
   * whole table exists to end.
   */
  it("claims the sender's address for the party it just created", async () => {
    const recorder: Recorder = { inserts: [], updates: [] };
    await runWorkflow(makeDb(recorder, null), memoryStore());

    expect(insertsInto(recorder, "party_identifiers")).toEqual([
      {
        organizationId: "org-1",
        partyId: "party-new",
        kind: "email",
        value: "Priya@Example.com",
        normalisedValue: "priya@example.com",
      },
    ]);
  });

  describe("a call, which is the channel that could not be filed before", () => {
    /**
     * The defect this ticket exists for, asserted from the other side: the
     * number lands in the column that holds numbers, and the party is claimed
     * under kind `phone`.
     */
    it("files a caller as a telephone number rather than as an email address", async () => {
      const recorder: Recorder = { inserts: [], updates: [] };
      await runWorkflow(makeDb(recorder, null, CALL_FIXTURE), memoryStore());

      const [party] = insertsInto(recorder, "business_parties");
      expect(party).toMatchObject({ name: "Priya Raman", phone: "+14155551212" });
      expect(party?.email).toBeUndefined();

      expect(insertsInto(recorder, "party_identifiers")).toEqual([
        {
          organizationId: "org-1",
          partyId: "party-new",
          kind: "phone",
          value: "+1 (415) 555-1212",
          normalisedValue: "+14155551212",
        },
      ]);
    });

    /**
     * `record-participants` used to write zero rows for this channel, because
     * `externalParticipants` required a domain. `AutonomyService.loadActivity`
     * then left-joined that table for a sender that could never be in it, and
     * handed the bounce classifier an empty address for every call.
     */
    it("records both ends of the call, normalised as telephone numbers", async () => {
      const recorder: Recorder = { inserts: [], updates: [] };
      await runWorkflow(makeDb(recorder, null, CALL_FIXTURE), memoryStore());

      expect(insertsInto(recorder, "activity_participants")).toEqual([
        expect.objectContaining({ address: "+14155551212", role: "from", partyId: "party-new" }),
        expect.objectContaining({ address: "+14155559000", role: "to", partyId: null }),
      ]);
    });

    it("matches a caller it already knows without creating a duplicate", async () => {
      const recorder: Recorder = { inserts: [], updates: [] };
      await runWorkflow(makeDb(recorder, "party-existing", CALL_FIXTURE), memoryStore());

      expect(insertsInto(recorder, "business_parties")).toHaveLength(0);
      expect(insertsInto(recorder, "party_identifiers")).toHaveLength(0);
      expect(insertsInto(recorder, "activities")[0]).toMatchObject({ partyId: "party-existing" });
    });
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

  /**
   * The read that happens before the first step, which is the one place in this
   * file with no tenant context of its own.
   */
  it("reads the receipt inside a tenant transaction for the run's organisation", async () => {
    await runWorkflow(makeDb({ inserts: [], updates: [] }, null), memoryStore());
    expect(mockTenantTransactions).toEqual(["org-1"]);
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
      // Its own step, after the decisions exist. Scoring is another provider
      // call, and folding it into extract-and-act would mean a scorer outage
      // retried the extraction — spending twice and risking a second set of
      // writes to undo the first.
      "shadow-score",
      "mark-processed",
    ]);
  });
});

/**
 * Ticket 07 — the limit binds the writer nobody asked to write.
 *
 * Every quota in the platform was written for a request a person made, and this
 * path has no person on it. The tests below assert the consequence rather than
 * the call: no party row, the message still filed, and a decision a tenant can
 * read. A test that the guard was *consulted* would pass just as happily with
 * the party still being created.
 */
describe("a plan limit reached, with nobody there to be told about it", () => {
  const AT_CAP = { limitFor: async () => 100 };

  it("does not create the party the plan has no room for", async () => {
    const recorder: Recorder = { inserts: [], updates: [] };
    await runWorkflow(makeDb(recorder, null, FIXTURE, 100), memoryStore(), AT_CAP);

    expect(insertsInto(recorder, "business_parties")).toEqual([]);
  });

  /**
   * The half that makes refusing safe enough to do.
   *
   * A cap that drops the customer's email is worse than no cap: the tenant has
   * lost a message and does not know it. The communication is filed
   * unattributed, so it is visible, searchable, and a person can attach it to
   * somebody by hand.
   */
  it("still files the message, unattributed rather than unrecorded", async () => {
    const recorder: Recorder = { inserts: [], updates: [] };
    await runWorkflow(makeDb(recorder, null, FIXTURE, 100), memoryStore(), AT_CAP);

    const logged = insertsInto(recorder, "activities");
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ partyId: null, subject: "Quote for Q3" });
  });

  it("records the refusal as a decision, so the tenant discovers the limit", async () => {
    const recorder: Recorder = { inserts: [], updates: [] };
    await runWorkflow(makeDb(recorder, null, FIXTURE, 100), memoryStore(), AT_CAP);

    const refusal = insertsInto(recorder, "autonomous_decisions").find(
      (row) => row["outcome"] === "skipped",
    );

    expect(refusal).toMatchObject({ kind: "party.created", outcome: "skipped" });
    // Naming the limit and the count is the difference between a tenant knowing
    // they have a problem and knowing how to stop having it.
    expect(String(refusal?.["summary"])).toContain("100");
    expect(refusal?.["decision"]).toMatchObject({
      refusedBy: "plan-limit",
      limit: 100,
      current: 100,
    });
  });

  it("also claims no identifier, so the refused party cannot be half-created", async () => {
    const recorder: Recorder = { inserts: [], updates: [] };
    await runWorkflow(makeDb(recorder, null, FIXTURE, 100), memoryStore(), AT_CAP);

    expect(insertsInto(recorder, "party_identifiers")).toEqual([]);
  });

  it("closes the receipt, so the refusal does not retry forever", async () => {
    const store = memoryStore();
    await runWorkflow(
      makeDb({ inserts: [], updates: [] }, null, FIXTURE, 100),
      store,
      AT_CAP,
    );

    expect(store.rows.map((row) => row.stepName)).toContain("mark-processed");
  });

  it("creates the party when the plan still has room", async () => {
    const recorder: Recorder = { inserts: [], updates: [] };
    await runWorkflow(makeDb(recorder, null, FIXTURE, 99), memoryStore(), AT_CAP);

    expect(insertsInto(recorder, "business_parties")).toHaveLength(1);
  });

  /**
   * The inverse failure, which the largest customers would have found first.
   *
   * `PLAN_LIMITS` spells unlimited `null`. A guard that read that as zero — or
   * that only understood a negative sentinel — would refuse every autonomous
   * write on the most expensive plan we sell.
   */
  it("creates the party on an unlimited plan rather than refusing every one", async () => {
    const recorder: Recorder = { inserts: [], updates: [] };
    await runWorkflow(
      makeDb(recorder, null, FIXTURE, 10_000),
      memoryStore(),
      { limitFor: async () => null },
    );

    expect(insertsInto(recorder, "business_parties")).toHaveLength(1);
  });
});
