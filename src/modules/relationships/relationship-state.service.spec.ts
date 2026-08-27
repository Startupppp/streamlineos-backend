import type { Db } from "../../db/drizzle.types";
import {
  activities,
  activityParticipants,
  relationshipParticipants,
  relationshipStates,
  relationshipThreads,
} from "../../db/schema";
import { RelationshipStateService } from "./relationship-state.service";

/**
 * The materialiser, against a database stand-in that records what it was told.
 *
 * The claims a mock can settle are the ones about routing and consequence: that
 * the anchor is taken from the activity rather than guessed, that a
 * subject-anchored activity is left alone rather than being folded into a
 * relationship it is not about, that the children are replaced rather than
 * merged, and that a failure to materialise never takes down the write it was
 * derived from.
 *
 * The claim that matters most — that a rebuild reproduces the maintained state —
 * is not one of them, because with a stand-in both paths are the same fake. That
 * one is `relationship-state.db.spec.ts`, against a real connection.
 */

const ORG = "org-1";

interface Recorded {
  updates: Record<string, unknown>[];
  inserts: { table: unknown; values: unknown }[];
  deletes: unknown[];
  transactions: number;
}

type Row = Record<string, unknown>;

function thenable<T>(rows: T[]) {
  const chain = {
    then: (resolve: (value: T[]) => unknown, reject?: (error: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
    where: () => chain,
    orderBy: () => chain,
    limit: async () => rows,
  };
  return chain;
}

/**
 * `reads` is keyed by table so the stand-in answers the question that was asked
 * rather than the next question in a queue — the two get out of step the moment
 * a code path takes a different branch, and then the test is asserting against
 * an accident.
 */
function makeDb(rec: Recorded, reads: Map<unknown, Row[]>, existingState: Row | null) {
  const writer = {
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          rec.updates.push(values);
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: unknown) => {
        rec.inserts.push({ table, values });
        const result = {
          onConflictDoUpdate: () => ({
            returning: async () => [{ relationshipStateId: "rel-new" }],
          }),
          then: (resolve: (value: unknown) => unknown) => Promise.resolve(undefined).then(resolve),
        };
        return result;
      },
    }),
    delete: (table: unknown) => ({
      where: async () => {
        rec.deletes.push(table);
      },
    }),
    select: () => ({
      from: (table: unknown) =>
        thenable(table === relationshipStates ? (existingState ? [existingState] : []) : (reads.get(table) ?? [])),
    }),
  };

  return {
    ...writer,
    // A transaction mock that does not invoke its callback silently voids every
    // assertion inside it, so this one runs the body and counts that it did.
    transaction: async (body: (tx: unknown) => Promise<unknown>) => {
      rec.transactions += 1;
      return body(writer);
    },
  } as unknown as Db;
}

function recorder(): Recorded {
  return { updates: [], inserts: [], deletes: [], transactions: 0 };
}

const activityRows = (over: Partial<Row> = {}): Row[] => [
  {
    activityId: "a1",
    kind: "email",
    occurredAt: new Date("2026-08-03T09:00:00Z"),
    subject: "Pricing",
    threadId: "t-1",
    actorKind: "human",
    source: "manual",
    ...over,
  },
];

describe("bringing one relationship up to date", () => {
  it("takes the anchor from the activity rather than from the caller", async () => {
    const rec = recorder();
    const reads = new Map<unknown, Row[]>([
      [activities, [{ partyId: "party-9", dealId: null }]],
      [activityParticipants, []],
    ]);
    const service = new RelationshipStateService(makeDb(rec, reads, null));

    await service.onActivity(ORG, "a1");

    expect(rec.transactions).toBe(1);
    const state = rec.inserts.find((row) => row.table === relationshipStates);
    expect(state?.values).toMatchObject({ organizationId: ORG, partyId: "party-9", dealId: null });
  });

  /**
   * A subject is a record on the generic renderer, not a counterparty. "How
   * quickly do they reply" is not a question about one, and folding its
   * activities into a relationship would invent a correspondent.
   */
  it("leaves a subject-anchored activity alone", async () => {
    const rec = recorder();
    const reads = new Map<unknown, Row[]>([[activities, [{ partyId: null, dealId: null }]]]);
    const service = new RelationshipStateService(makeDb(rec, reads, null));

    await service.onActivity(ORG, "a1");

    expect(rec.transactions).toBe(0);
    expect(rec.inserts).toEqual([]);
  });

  it("does nothing at all for an activity another tenant owns", async () => {
    const rec = recorder();
    const service = new RelationshipStateService(makeDb(rec, new Map([[activities, []]]), null));

    await service.onActivity(ORG, "a1");

    expect(rec.transactions).toBe(0);
  });

  it("writes the folded numbers rather than incrementing whatever was there", async () => {
    const rec = recorder();
    const reads = new Map<unknown, Row[]>([
      [activities, activityRows()],
      [activityParticipants, [{ activityId: "a1", partyId: null, userId: "user-rep", address: null, role: "from" }]],
    ]);
    const service = new RelationshipStateService(makeDb(rec, reads, { relationshipStateId: "rel-1" }));

    await service.rebuild(ORG, { kind: "party", partyId: "party-9" });

    // An existing row is updated in place, so the identifier the children hang
    // off does not change under them.
    expect(rec.inserts.some((row) => row.table === relationshipStates)).toBe(false);
    expect(rec.updates[0]).toMatchObject({
      outboundCount: 1,
      inboundCount: 0,
      contactCount: 1,
      participantCount: 1,
      threadCount: 1,
      replySampleCount: 0,
      awaitingReplySince: new Date("2026-08-03T09:00:00Z"),
    });
  });

  /**
   * Replaced, never merged. The state is a function of the activities, so a
   * participant this fold did not produce is one the activities no longer
   * support — and merging would keep a contact on the relationship forever after
   * they left the thread.
   */
  it("clears the children before it writes them", async () => {
    const rec = recorder();
    const reads = new Map<unknown, Row[]>([
      [activities, activityRows()],
      [activityParticipants, [{ activityId: "a1", partyId: null, userId: null, address: "priya@northwind.test", role: "from" }]],
    ]);
    const service = new RelationshipStateService(makeDb(rec, reads, { relationshipStateId: "rel-1" }));

    await service.rebuild(ORG, { kind: "party", partyId: "party-9" });

    expect(rec.deletes).toEqual([relationshipParticipants, relationshipThreads]);
    const people = rec.inserts.find((row) => row.table === relationshipParticipants);
    expect(people?.values).toEqual([
      expect.objectContaining({
        identity: "address:priya@northwind.test",
        roles: ["from"],
        repliedCount: 1,
        messageCount: 1,
      }),
    ]);
    const threads = rec.inserts.find((row) => row.table === relationshipThreads);
    expect(threads?.values).toEqual([
      expect.objectContaining({ threadId: "t-1", lastDirection: "inbound", precededByThreadId: null }),
    ]);
  });

  it("writes no child rows at all when there is nothing to write", async () => {
    const rec = recorder();
    const reads = new Map<unknown, Row[]>([[activities, []]]);
    const service = new RelationshipStateService(makeDb(rec, reads, { relationshipStateId: "rel-1" }));

    await service.rebuild(ORG, { kind: "deal", dealId: "77" });

    // The state row is still written — a relationship with no history is a fact
    // about it, and the row is what a silence sweep skips over.
    expect(rec.updates[0]).toMatchObject({ contactCount: 0, observedFrom: null });
    expect(rec.inserts.filter((row) => row.table !== relationshipStates)).toEqual([]);
  });
});

describe("when the materialisation cannot be written", () => {
  /**
   * Filing a customer's message must not depend on summarising it. A delivery
   * rejected because a derived table could not be written is a lost message; a
   * state one activity behind is repaired by the next one.
   */
  it("keeps the failure off the caller and out of silence", async () => {
    const service = new RelationshipStateService({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              throw new Error("42501");
            },
          }),
        }),
      }),
    } as unknown as Db);

    const warn = jest.spyOn(service["logger"], "warn").mockImplementation(() => undefined);

    await expect(service.tryOnActivity(ORG, "a1")).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("a1");

    warn.mockRestore();
  });

  it("lets an explicit rebuild fail loudly, because nothing else is riding on it", async () => {
    const service = new RelationshipStateService({
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: async () => {
                throw new Error("42501");
              },
            }),
          }),
        }),
      }),
    } as unknown as Db);

    await expect(service.rebuild(ORG, { kind: "party", partyId: "party-9" })).rejects.toThrow("42501");
  });
});
