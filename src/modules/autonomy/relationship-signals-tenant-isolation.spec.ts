import type { Db } from "../../db/drizzle.types";
import { RelationshipSignalsService } from "./relationship-signals.service";
import { DealsService } from "../deals/deals.service";
import type { StoredRelationship } from "../relationships/relationship-state.types";
import type { RelationshipState, RelationshipThreadState, ReplyLatency } from "../relationships/relationship-state";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((i) => sqlValues(i, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const r = value as { queryChunks?: unknown[]; value?: unknown };
  return [...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [])];
}

const OWNER_ORG = "org-owner";
const ATTACKER_ORG = "org-attacker";

function makeRelState(threads: RelationshipThreadState[]): RelationshipState {
  const now = new Date();
  const replyLatency: ReplyLatency = { sampleCount: 0, p50Seconds: null, p90Seconds: null, minSeconds: null, maxSeconds: null };
  return {
    observedFrom: now,
    lastContactAt: now,
    lastInboundAt: null,
    lastOutboundAt: null,
    lastInboundActivityId: null,
    lastOutboundActivityId: null,
    awaitingReplySince: null,
    contactCount: 1,
    inboundCount: 0,
    outboundCount: 1,
    unreadableDirectionCount: 0,
    replyLatency,
    participants: [],
    threads,
  };
}

function makeThreadForkPair(): [StoredRelationship, StoredRelationship] {
  const now = new Date();
  const preceding: RelationshipThreadState = {
    threadId: "t-1",
    subject: "Pricing discussion",
    firstSeenAt: now,
    lastSeenAt: now,
    messageCount: 3,
    lastDirection: "outbound",
    precededByThreadId: null,
  };
  const fork: RelationshipThreadState = {
    threadId: "t-2",
    subject: "Contract review",
    firstSeenAt: now,
    lastSeenAt: now,
    messageCount: 1,
    lastDirection: "inbound",
    precededByThreadId: "t-1",
  };
  const before: StoredRelationship = {
    relationshipStateId: "state-before",
    anchor: { kind: "deal", dealId: 10 },
    state: makeRelState([preceding]),
  };
  const after: StoredRelationship = {
    relationshipStateId: "state-after",
    anchor: { kind: "deal", dealId: 10 },
    state: makeRelState([preceding, fork]),
  };
  return [before, after];
}

function makeDb() {
  const selectWhere = jest.fn().mockReturnValue({
    orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
  });
  const db = {
    select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where: selectWhere }) }),
    insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue([]) }),
  } as unknown as Db;
  return { db, selectWhere };
}

describe("RelationshipSignalsService — cross-tenant isolation", () => {
  it("seedForFork scopes the deals SELECT to the caller's org (cross-tenant isolation)", async () => {
    const { db, selectWhere } = makeDb();
    const svc = new RelationshipSignalsService(db, {} as unknown as DealsService);
    const [before, after] = makeThreadForkPair();

    await svc.evaluate(ATTACKER_ORG, "activity-1", before, after);

    expect(selectWhere).toHaveBeenCalled();
    const vals = sqlValues(selectWhere.mock.calls[0]?.[0]);
    expect(vals).toContain(ATTACKER_ORG);
  });

  it("does not open a deal in the attacker org when no seed exists there (control: no cross-tenant deal creation)", async () => {
    const { db } = makeDb();
    const createDeal = jest.fn();
    const svc = new RelationshipSignalsService(db, { createDeal } as unknown as DealsService);
    const [before, after] = makeThreadForkPair();

    await svc.evaluate(ATTACKER_ORG, "activity-2", before, after);

    expect(createDeal).not.toHaveBeenCalled();
  });

  it("seedForFork scopes to the owning org when querying its own deals (same-tenant control)", async () => {
    const { db, selectWhere } = makeDb();
    const svc = new RelationshipSignalsService(db, {} as unknown as DealsService);
    const [before, after] = makeThreadForkPair();

    await svc.evaluate(OWNER_ORG, "activity-3", before, after);

    const vals = sqlValues(selectWhere.mock.calls[0]?.[0]);
    expect(vals).toContain(OWNER_ORG);
    expect(vals).not.toContain(ATTACKER_ORG);
  });
});
