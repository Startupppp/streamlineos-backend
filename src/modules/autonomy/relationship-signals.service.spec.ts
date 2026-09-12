import type { Db } from "../../db/drizzle.types";
import { autonomousDecisions, deals } from "../../db/schema";
import type { DealsService } from "../deals/deals.service";
import { RelationshipSignalsService } from "./relationship-signals.service";
import type {
  RelationshipParticipantState,
  RelationshipState,
  RelationshipThreadState,
} from "../relationships/relationship-state";
import type { StoredRelationship } from "../relationships/relationship-state.types";

const ORG = "org-1";
const T = (iso: string): Date => new Date(iso);

function participant(
  identity: string,
  repliedCount: number,
  lastRepliedAt: string | null,
): RelationshipParticipantState {
  return {
    identity,
    partyId: null,
    userId: null,
    address: identity,
    roles: ["cc"],
    firstSeenAt: T("2026-01-01T00:00:00Z"),
    lastSeenAt: T(lastRepliedAt ?? "2026-01-01T00:00:00Z"),
    messageCount: repliedCount,
    repliedCount,
    lastRepliedAt: lastRepliedAt ? T(lastRepliedAt) : null,
  };
}

function relationship(
  participants: readonly RelationshipParticipantState[],
  threads: readonly RelationshipThreadState[] = [],
): StoredRelationship {
  const state: RelationshipState = {
    observedFrom: T("2026-01-01T00:00:00Z"),
    lastContactAt: null,
    lastInboundAt: null,
    lastOutboundAt: null,
    lastInboundActivityId: null,
    lastOutboundActivityId: null,
    awaitingReplySince: null,
    contactCount: 0,
    inboundCount: 0,
    outboundCount: 0,
    unreadableDirectionCount: 0,
    replyLatency: { sampleCount: 0, p50Seconds: null, p90Seconds: null, minSeconds: null, maxSeconds: null },
    participants,
    threads,
  };
  return { relationshipStateId: "rs-1", anchor: { kind: "party", partyId: "party-1" }, state };
}

/** A minimal `db` double: seeds a select on `deals`, records every insert. */
function fakeDb(dealSeed: { assignedToId: string; partyId: string | null } | null): {
  db: Db;
  inserted: (typeof autonomousDecisions.$inferInsert)[];
} {
  const inserted: (typeof autonomousDecisions.$inferInsert)[] = [];
  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          orderBy: () => ({
            limit: async () => (table === deals && dealSeed ? [dealSeed] : []),
          }),
        }),
      }),
    }),
    insert: (table: unknown) => ({
      values: (row: (typeof autonomousDecisions.$inferInsert)) => {
        if (table === autonomousDecisions) inserted.push(row);
        return Promise.resolve(undefined);
      },
    }),
  } as unknown as Db;
  return { db, inserted };
}

describe("RelationshipSignalsService", () => {
  it("records a participant-change decision, applied, when confidence clears the threshold", async () => {
    const { db, inserted } = fakeDb(null);
    const dealsService = { createDeal: jest.fn() } as unknown as DealsService;
    const service = new RelationshipSignalsService(db, dealsService);

    const before = relationship([
      participant("champion@x.test", 5, "2026-01-05T00:00:00Z"),
      participant("procurement@x.test", 1, "2026-01-02T00:00:00Z"),
    ]);
    const after = relationship([
      participant("champion@x.test", 5, "2026-01-05T00:00:00Z"),
      participant("procurement@x.test", 9, "2026-01-10T00:00:00Z"),
    ]);

    await service.evaluate(ORG, "act-1", before, after);

    const decision = inserted.find((r) => r.kind === "participant.changed");
    expect(decision).toBeDefined();
    expect(decision?.outcome).toBe("applied");
    expect(decision?.organizationId).toBe(ORG);
    expect(decision?.activityId).toBe("act-1");
    expect(decision?.reversibility).toBe("instant");
    expect(dealsService.createDeal).not.toHaveBeenCalled();
  });

  it("records a skipped participant-change decision below the confidence threshold", async () => {
    const { db, inserted } = fakeDb(null);
    const service = new RelationshipSignalsService(db, { createDeal: jest.fn() } as unknown as DealsService);

    // A one-reply margin — detectParticipantChange's floor, worth 0.6
    // confidence (0.5 + 1*0.1), below participant.changed's 0.65 threshold.
    const before = relationship([
      participant("a@x.test", 1, "2026-01-01T00:00:00Z"),
      participant("b@x.test", 0, null),
    ]);
    const after = relationship([
      participant("a@x.test", 1, "2026-01-01T00:00:00Z"),
      participant("b@x.test", 2, "2026-01-05T00:00:00Z"),
    ]);

    await service.evaluate(ORG, "act-1", before, after);

    const decision = inserted.find((r) => r.kind === "participant.changed");
    expect(decision?.outcome).toBe("skipped");
  });

  it("opens a second opportunity, inheriting owner and pipeline from the relationship's own deal", async () => {
    const { db, inserted } = fakeDb({ assignedToId: "usr-1", partyId: "party-1" });
    const created = { id: 42, name: "Onboarding timeline", stage: "LEAD" };
    const dealsService = { createDeal: jest.fn().mockResolvedValue(created) } as unknown as DealsService;
    const service = new RelationshipSignalsService(db, dealsService);

    const before = relationship([], [{ threadId: "t1", subject: "Pricing", firstSeenAt: T("2026-01-01T00:00:00Z"), lastSeenAt: T("2026-01-01T00:00:00Z"), messageCount: 1, lastDirection: "inbound", precededByThreadId: null }]);
    const after = relationship(
      [],
      [
        before.state.threads[0]!,
        { threadId: "t2", subject: "Onboarding timeline", firstSeenAt: T("2026-01-05T00:00:00Z"), lastSeenAt: T("2026-01-05T00:00:00Z"), messageCount: 1, lastDirection: "inbound", precededByThreadId: "t1" },
      ],
    );

    await service.evaluate(ORG, "act-2", before, after);

    expect(dealsService.createDeal).toHaveBeenCalledWith(
      ORG,
      "system",
      expect.objectContaining({ name: "Onboarding timeline", assignedToId: "usr-1", partyId: "party-1" }),
    );
    const decision = inserted.find((r) => r.kind === "thread.forked");
    expect(decision?.outcome).toBe("applied");
    expect(decision?.dealId).toBe("42");
  });

  it("records the fork but skips creating a deal when there is nothing to inherit an owner from", async () => {
    const { db, inserted } = fakeDb(null);
    const dealsService = { createDeal: jest.fn() } as unknown as DealsService;
    const service = new RelationshipSignalsService(db, dealsService);

    const before = relationship([], [{ threadId: "t1", subject: "Pricing", firstSeenAt: T("2026-01-01T00:00:00Z"), lastSeenAt: T("2026-01-01T00:00:00Z"), messageCount: 1, lastDirection: "inbound", precededByThreadId: null }]);
    const after = relationship(
      [],
      [
        before.state.threads[0]!,
        { threadId: "t2", subject: "Onboarding timeline", firstSeenAt: T("2026-01-05T00:00:00Z"), lastSeenAt: T("2026-01-05T00:00:00Z"), messageCount: 1, lastDirection: "inbound", precededByThreadId: "t1" },
      ],
    );

    await service.evaluate(ORG, "act-3", before, after);

    expect(dealsService.createDeal).not.toHaveBeenCalled();
    const decision = inserted.find((r) => r.kind === "thread.forked");
    expect(decision?.outcome).toBe("skipped");
  });

  it("evaluates both signals independently in one call", async () => {
    const { db, inserted } = fakeDb(null);
    const service = new RelationshipSignalsService(db, { createDeal: jest.fn() } as unknown as DealsService);

    // Neither signal's structural condition holds — nothing recorded at all.
    const before = relationship([participant("a@x.test", 2, "2026-01-01T00:00:00Z")]);
    const after = relationship([participant("a@x.test", 3, "2026-01-05T00:00:00Z")]);

    await service.evaluate(ORG, "act-4", before, after);

    expect(inserted).toHaveLength(0);
  });
});
