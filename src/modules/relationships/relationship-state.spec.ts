import {
  RELATIONSHIP_WINDOW_MAX_ACTIVITIES,
  directionOf,
  foldRelationshipState,
  participantIdentity,
  type RelationshipActivityRow,
} from "./relationship-state";

/**
 * The fold, argued with directly.
 *
 * Ticket 01's load-bearing claim is that the relationship state is a
 * materialisation rather than a second source of truth, and the only way that
 * claim survives contact with an incremental writer is if the thing being
 * written is a pure function of the activities. So it is written as one, and
 * this file is where its properties are settled — order independence,
 * idempotence and a window that does not move under the reader's feet — before
 * a database is involved at all.
 */

const T = (iso: string): Date => new Date(iso);

/** An inbound message, as the ingress seam files one. */
function inbound(
  id: string,
  at: string,
  options: { thread?: string | null; from?: string; subject?: string | null; cc?: string[] } = {},
): RelationshipActivityRow {
  return {
    activityId: id,
    kind: "email",
    occurredAt: T(at),
    subject: options.subject ?? "Pricing",
    threadId: options.thread === undefined ? "thread-1" : options.thread,
    actorKind: "system",
    source: "gmail",
    participants: [
      { partyId: null, userId: null, address: options.from ?? "priya@northwind.test", role: "from" },
      ...(options.cc ?? []).map((address) => ({
        partyId: null,
        userId: null,
        address,
        role: "cc",
      })),
    ],
  };
}

/** Something one of our people did — a logged call, a sent mail. */
function outbound(
  id: string,
  at: string,
  options: { thread?: string | null; user?: string; subject?: string | null } = {},
): RelationshipActivityRow {
  return {
    activityId: id,
    kind: "email",
    occurredAt: T(at),
    subject: options.subject ?? "Pricing",
    threadId: options.thread === undefined ? "thread-1" : options.thread,
    actorKind: "human",
    source: "manual",
    participants: [
      { partyId: null, userId: options.user ?? "user-rep", address: null, role: "from" },
      { partyId: null, userId: null, address: "priya@northwind.test", role: "to" },
    ],
  };
}

describe("which way a contact travelled", () => {
  it("reads a message from someone who is not one of ours as inbound", () => {
    expect(directionOf(inbound("a", "2026-08-01T09:00:00Z"))).toBe("inbound");
  });

  it("reads a message sent by one of our people as outbound", () => {
    expect(directionOf(outbound("a", "2026-08-01T09:00:00Z"))).toBe("outbound");
  });

  /**
   * The sender decides, not the actor column.
   *
   * A rep pasting a customer's reply into the CRM by hand is filed `human`, and
   * reading the actor column alone would call the customer's own words ours.
   */
  it("believes the sender over the actor column", () => {
    const pastedByHand: RelationshipActivityRow = {
      ...inbound("a", "2026-08-01T09:00:00Z"),
      actorKind: "human",
      source: "manual",
    };
    expect(directionOf(pastedByHand)).toBe("inbound");
  });

  it("counts neither a task nor the system's own extraction as contact", () => {
    const task: RelationshipActivityRow = {
      ...inbound("a", "2026-08-01T09:00:00Z"),
      kind: "task",
    };
    const extracted: RelationshipActivityRow = {
      ...inbound("b", "2026-08-01T09:00:00Z"),
      source: "extraction",
    };
    expect(directionOf(task)).toBeNull();
    expect(directionOf(extracted)).toBeNull();
  });

  /**
   * A direction we cannot read is not a direction we may assume — the same rule
   * the telephony adapter already applies to a provider that states none.
   */
  it("refuses to guess when nobody is recorded as the sender", () => {
    const senderless: RelationshipActivityRow = {
      activityId: "a",
      kind: "note",
      occurredAt: T("2026-08-01T09:00:00Z"),
      subject: null,
      threadId: null,
      actorKind: "system",
      source: "importer",
      participants: [],
    };
    expect(directionOf(senderless)).toBeNull();
  });
});

describe("what normal looks like for one relationship", () => {
  const history = [
    outbound("o1", "2026-08-03T09:00:00Z"),
    inbound("i1", "2026-08-03T10:00:00Z"),
    outbound("o2", "2026-08-04T09:00:00Z"),
    inbound("i2", "2026-08-04T11:00:00Z"),
    outbound("o3", "2026-08-05T09:00:00Z"),
  ];

  it("remembers the last contact in each direction separately", () => {
    const state = foldRelationshipState(history);

    expect(state.lastInboundAt).toEqual(T("2026-08-04T11:00:00Z"));
    expect(state.lastInboundActivityId).toBe("i2");
    expect(state.lastOutboundAt).toEqual(T("2026-08-05T09:00:00Z"));
    expect(state.lastOutboundActivityId).toBe("o3");
    expect(state.lastContactAt).toEqual(T("2026-08-05T09:00:00Z"));
  });

  it("counts each direction, and says how much it could not read", () => {
    const withMystery = [
      ...history,
      {
        activityId: "m1",
        kind: "note",
        occurredAt: T("2026-08-06T09:00:00Z"),
        subject: null,
        threadId: null,
        actorKind: "system",
        source: "importer",
        participants: [],
      } satisfies RelationshipActivityRow,
    ];
    const state = foldRelationshipState(withMystery);

    expect(state.inboundCount).toBe(2);
    expect(state.outboundCount).toBe(3);
    expect(state.contactCount).toBe(5);
    expect(state.unreadableDirectionCount).toBe(1);
  });

  /**
   * The reply clock starts when the ball entered their court, which is the FIRST
   * message of our run they had not yet answered — not the last one. Chasing
   * somebody three times in an hour does not make them a fast replier.
   */
  it("measures a reply from the moment the ball entered their court", () => {
    const chased = [
      outbound("o1", "2026-08-03T09:00:00Z"),
      outbound("o2", "2026-08-03T11:00:00Z"),
      inbound("i1", "2026-08-03T12:00:00Z"),
    ];
    const state = foldRelationshipState(chased);

    expect(state.replyLatency.sampleCount).toBe(1);
    expect(state.replyLatency.p50Seconds).toBe(3 * 3600);
  });

  it("builds a distribution rather than an average", () => {
    const state = foldRelationshipState(history);

    expect(state.replyLatency.sampleCount).toBe(2);
    expect(state.replyLatency.minSeconds).toBe(3600);
    expect(state.replyLatency.maxSeconds).toBe(2 * 3600);
    expect(state.replyLatency.p50Seconds).toBe(3600);
    expect(state.replyLatency.p90Seconds).toBe(2 * 3600);
  });

  it("says nothing about latency when nobody has ever replied", () => {
    const state = foldRelationshipState([outbound("o1", "2026-08-03T09:00:00Z")]);

    expect(state.replyLatency.sampleCount).toBe(0);
    expect(state.replyLatency.p50Seconds).toBeNull();
    expect(state.replyLatency.p90Seconds).toBeNull();
  });

  /**
   * Whose turn it is, as a timestamp rather than a boolean, because ticket 02
   * needs to know how long it has been their turn and a boolean cannot say.
   */
  it("records when the ball entered their court, and clears it when they reply", () => {
    expect(foldRelationshipState(history).awaitingReplySince).toEqual(T("2026-08-05T09:00:00Z"));

    const theyAnswered = [...history, inbound("i3", "2026-08-05T09:30:00Z")];
    expect(foldRelationshipState(theyAnswered).awaitingReplySince).toBeNull();
  });

  it("keeps every participant with the roles they were seen in", () => {
    const state = foldRelationshipState([
      inbound("i1", "2026-08-03T10:00:00Z", { cc: ["ops@northwind.test"] }),
      outbound("o1", "2026-08-04T09:00:00Z"),
    ]);

    const customer = state.participants.find((p) => p.address === "priya@northwind.test");
    expect(customer?.roles).toEqual(["from", "to"]);
    expect(customer?.repliedCount).toBe(1);
    expect(customer?.lastRepliedAt).toEqual(T("2026-08-03T10:00:00Z"));

    const copied = state.participants.find((p) => p.address === "ops@northwind.test");
    expect(copied?.roles).toEqual(["cc"]);
    expect(copied?.repliedCount).toBe(0);

    const ours = state.participants.find((p) => p.userId === "user-rep");
    expect(ours?.roles).toEqual(["from"]);
    expect(ours?.repliedCount).toBe(0);
  });

  it("gives a participant one identity whichever way the row named them", () => {
    expect(participantIdentity({ partyId: "p1", userId: null, address: null, role: "from" })).toBe(
      "party:p1",
    );
    expect(participantIdentity({ partyId: null, userId: "u1", address: null, role: "from" })).toBe(
      "user:u1",
    );
    expect(
      participantIdentity({ partyId: null, userId: null, address: " Priya@Example.com ", role: "to" }),
    ).toBe("address:priya@example.com");
    expect(participantIdentity({ partyId: null, userId: null, address: null, role: "to" })).toBeNull();
  });

  /**
   * Lineage as adjacency, and named for what it actually is.
   *
   * Nothing in the activity model carries a provider-stated parent — there is no
   * `In-Reply-To` below the seam — so calling this `parentThreadId` would be a
   * claim the data cannot support. What IS observable is which conversation was
   * live when this one started, and that is the whole of what ticket 03's fork
   * detection needs.
   */
  it("records which conversation was live when a new one started", () => {
    const state = foldRelationshipState([
      inbound("i1", "2026-08-03T10:00:00Z", { thread: "t-a", subject: "Pricing" }),
      outbound("o1", "2026-08-04T09:00:00Z", { thread: "t-a", subject: "Pricing" }),
      inbound("i2", "2026-08-04T15:00:00Z", { thread: "t-b", subject: "Renewal" }),
    ]);

    const threads = Object.fromEntries(state.threads.map((t) => [t.threadId, t]));
    expect(threads["t-a"]?.precededByThreadId).toBeNull();
    expect(threads["t-a"]?.messageCount).toBe(2);
    expect(threads["t-a"]?.subject).toBe("Pricing");
    expect(threads["t-b"]?.precededByThreadId).toBe("t-a");
    expect(threads["t-b"]?.lastDirection).toBe("inbound");
  });

  it("leaves an unthreaded activity out of the lineage rather than inventing a thread", () => {
    const state = foldRelationshipState([inbound("i1", "2026-08-03T10:00:00Z", { thread: null })]);
    expect(state.threads).toEqual([]);
    expect(state.inboundCount).toBe(1);
  });
});

describe("the properties an incremental writer depends on", () => {
  const history = [
    outbound("o1", "2026-08-03T09:00:00Z"),
    inbound("i1", "2026-08-03T10:00:00Z", { cc: ["ops@northwind.test"] }),
    outbound("o2", "2026-08-04T09:00:00Z", { thread: "t-b", subject: "Renewal" }),
    inbound("i2", "2026-08-04T11:00:00Z", { thread: "t-b", subject: "Renewal" }),
  ];

  /**
   * A late delivery is the ordinary case, not the exotic one — a provider
   * backfills, an operator re-runs an import — so arrival order may not decide
   * anything the state says.
   */
  it("does not care what order the activities arrived in", () => {
    const forwards = foldRelationshipState(history);
    const backwards = foldRelationshipState([...history].reverse());
    const shuffled = foldRelationshipState([history[2], history[0], history[3], history[1]]);

    expect(backwards).toEqual(forwards);
    expect(shuffled).toEqual(forwards);
  });

  /** A retried delivery must not double a count or move a timestamp. */
  it("is unchanged by seeing the same activity twice", () => {
    expect(foldRelationshipState([...history, ...history])).toEqual(
      foldRelationshipState(history),
    );
  });

  /**
   * Timestamps collide — an imported mail folder writes hundreds in the same
   * second — so the identifier is the tie-break, exactly as it is on every
   * cursor over this table.
   */
  it("orders a collision by identifier rather than leaving it to chance", () => {
    const sameInstant = [
      outbound("o-b", "2026-08-03T09:00:00Z"),
      inbound("i-a", "2026-08-03T09:00:00Z"),
    ];

    const state = foldRelationshipState(sameInstant);
    // `i-a` sorts first, so the outbound is the later of the two and the ball is
    // in their court — the opposite of what wall-clock order alone would say.
    expect(state.awaitingReplySince).toEqual(T("2026-08-03T09:00:00Z"));
    expect(state.replyLatency.sampleCount).toBe(0);
    expect(foldRelationshipState([...sameInstant].reverse())).toEqual(state);
  });

  /**
   * The window is a count and never a duration, and that is the whole reason a
   * rebuild can reproduce the state. A "last 90 days" bound would make the
   * answer depend on when it was asked, so a rebuild tomorrow would differ from
   * the state maintained today with no activity having changed — which is
   * precisely the drift a materialisation exists to avoid.
   */
  it("keeps the newest activities when there are more than the window holds", () => {
    const many: RelationshipActivityRow[] = [];
    for (let i = 0; i < RELATIONSHIP_WINDOW_MAX_ACTIVITIES + 20; i += 1) {
      const at = new Date(T("2026-01-01T00:00:00Z").getTime() + i * 3_600_000).toISOString();
      many.push(inbound(`i${String(i).padStart(4, "0")}`, at));
    }

    const state = foldRelationshipState(many);
    expect(state.contactCount).toBe(RELATIONSHIP_WINDOW_MAX_ACTIVITIES);
    expect(state.lastInboundActivityId).toBe(`i${String(many.length - 1).padStart(4, "0")}`);
    expect(state.observedFrom).toEqual(many[many.length - RELATIONSHIP_WINDOW_MAX_ACTIVITIES].occurredAt);
  });

  /**
   * The claim ticket 01 actually makes, in the only form a pure test can make
   * it: replaying the history one activity at a time and folding the whole of it
   * at the end are the same computation, so an incremental writer that calls
   * this function cannot drift from a rebuild that calls it.
   *
   * `relationship-state.db.spec.ts` makes the same claim against a real
   * database, where the two paths are genuinely different code.
   */
  it("reaches the same state whether it is fed all at once or one at a time", () => {
    const seen: RelationshipActivityRow[] = [];
    let incremental = foldRelationshipState([]);
    for (const activity of history) {
      seen.push(activity);
      incremental = foldRelationshipState(seen);
    }

    expect(incremental).toEqual(foldRelationshipState(history));
  });

  it("describes an empty relationship without pretending to know anything", () => {
    const state = foldRelationshipState([]);

    expect(state.contactCount).toBe(0);
    expect(state.lastContactAt).toBeNull();
    expect(state.awaitingReplySince).toBeNull();
    expect(state.replyLatency.sampleCount).toBe(0);
    expect(state.participants).toEqual([]);
    expect(state.threads).toEqual([]);
  });
});
