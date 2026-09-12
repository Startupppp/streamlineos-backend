import { detectParticipantChange, detectThreadFork } from "./relationship-signals";
import type {
  RelationshipParticipantState,
  RelationshipState,
  RelationshipThreadState,
} from "../../relationships/relationship-state";
import type { StoredRelationship } from "../../relationships/relationship-state.types";

const T = (iso: string): Date => new Date(iso);

function participant(
  identity: string,
  repliedCount: number,
  lastRepliedAt: string | null,
  roles: readonly string[] = ["cc"],
): RelationshipParticipantState {
  return {
    identity,
    partyId: null,
    userId: null,
    address: identity,
    roles,
    firstSeenAt: T("2026-01-01T00:00:00Z"),
    lastSeenAt: T(lastRepliedAt ?? "2026-01-01T00:00:00Z"),
    messageCount: repliedCount,
    repliedCount,
    lastRepliedAt: lastRepliedAt ? T(lastRepliedAt) : null,
  };
}

function thread(
  threadId: string,
  subject: string | null,
  precededByThreadId: string | null = null,
): RelationshipThreadState {
  return {
    threadId,
    subject,
    firstSeenAt: T("2026-01-01T00:00:00Z"),
    lastSeenAt: T("2026-01-01T00:00:00Z"),
    messageCount: 1,
    lastDirection: "inbound",
    precededByThreadId,
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
    contactCount: participants.reduce((s, p) => s + p.messageCount, 0),
    inboundCount: 0,
    outboundCount: 0,
    unreadableDirectionCount: 0,
    replyLatency: { sampleCount: 0, p50Seconds: null, p90Seconds: null, minSeconds: null, maxSeconds: null },
    participants,
    threads,
  };
  return { relationshipStateId: "rs-1", anchor: { kind: "party", partyId: "party-1" }, state };
}

describe("detectParticipantChange", () => {
  it("does nothing when there is no previous state to compare against", () => {
    expect(detectParticipantChange(null, relationship([participant("a@x.test", 3, "2026-01-05T00:00:00Z")]))).toBeNull();
  });

  it("does nothing when nothing has ever replied on either side", () => {
    const before = relationship([participant("a@x.test", 0, null)]);
    const after = relationship([participant("a@x.test", 0, null), participant("b@x.test", 0, null)]);
    expect(detectParticipantChange(before, after)).toBeNull();
  });

  it("does nothing when the same person is still the primary responder", () => {
    const before = relationship([participant("a@x.test", 2, "2026-01-02T00:00:00Z")]);
    const after = relationship([participant("a@x.test", 3, "2026-01-05T00:00:00Z")]);
    expect(detectParticipantChange(before, after)).toBeNull();
  });

  it("does nothing on a one-reply margin with no evidence the old primary actually stopped", () => {
    // b overtakes a by exactly one reply, but a's last reply is still more
    // recent — reads as "both still active", not a handoff.
    const before = relationship([
      participant("champion@x.test", 3, "2026-01-05T00:00:00Z"),
      participant("procurement@x.test", 2, "2026-01-04T00:00:00Z"),
    ]);
    const after = relationship([
      participant("champion@x.test", 3, "2026-01-05T00:00:00Z"),
      participant("procurement@x.test", 4, "2026-01-03T00:00:00Z"),
    ]);
    expect(detectParticipantChange(before, after)).toBeNull();
  });

  it("fires when the champion goes quiet and procurement takes over, with a graded confidence", () => {
    const before = relationship([
      participant("champion@x.test", 5, "2026-01-05T00:00:00Z", ["decision-maker"]),
      participant("procurement@x.test", 1, "2026-01-02T00:00:00Z", ["influencer"]),
    ]);
    const after = relationship([
      participant("champion@x.test", 5, "2026-01-05T00:00:00Z", ["decision-maker"]),
      participant("procurement@x.test", 8, "2026-01-10T00:00:00Z", ["influencer"]),
    ]);

    const signal = detectParticipantChange(before, after);
    expect(signal).not.toBeNull();
    expect(signal?.droppedIdentity).toBe("champion@x.test");
    expect(signal?.risenIdentity).toBe("procurement@x.test");
    expect(signal?.confidence).toBeGreaterThan(0.5);
    expect(signal?.confidence).toBeLessThanOrEqual(0.95);
  });

  it("reports a larger margin as a higher confidence than a bare handoff", () => {
    const narrow = detectParticipantChange(
      relationship([participant("a@x.test", 2, "2026-01-01T00:00:00Z"), participant("b@x.test", 1, "2025-12-01T00:00:00Z")]),
      relationship([participant("a@x.test", 2, "2026-01-01T00:00:00Z"), participant("b@x.test", 3, "2026-01-05T00:00:00Z")]),
    );
    const wide = detectParticipantChange(
      relationship([participant("a@x.test", 2, "2026-01-01T00:00:00Z"), participant("b@x.test", 1, "2025-12-01T00:00:00Z")]),
      relationship([participant("a@x.test", 2, "2026-01-01T00:00:00Z"), participant("b@x.test", 9, "2026-01-05T00:00:00Z")]),
    );
    expect(wide!.confidence).toBeGreaterThan(narrow!.confidence);
  });
});

describe("detectThreadFork", () => {
  it("does nothing when there is nothing after", () => {
    expect(detectThreadFork(relationship([]), null)).toBeNull();
  });

  it("does nothing for the relationship's first thread — nothing preceded it", () => {
    const after = relationship([], [thread("t1", "Pricing", null)]);
    expect(detectThreadFork(null, after)).toBeNull();
  });

  it("does nothing when a thread continues under a slightly different subject", () => {
    const before = relationship([], [thread("t1", "Pricing", null)]);
    const after = relationship([], [thread("t1", "Pricing", null), thread("t2", "Re: Pricing — updated", "t1")]);
    expect(detectThreadFork(before, after)).toBeNull();
  });

  it("does nothing when the preceding thread's subject is unknown", () => {
    const before = relationship([], [thread("t1", null, null)]);
    const after = relationship([], [thread("t1", null, null), thread("t2", "Support ticket", "t1")]);
    expect(detectThreadFork(before, after)).toBeNull();
  });

  it("fires when a new thread forks into a genuinely distinct subject", () => {
    const before = relationship([], [thread("t1", "Pricing for Q1", null)]);
    const after = relationship([], [thread("t1", "Pricing for Q1", null), thread("t2", "Onboarding timeline", "t1")]);

    const signal = detectThreadFork(before, after);
    expect(signal).not.toBeNull();
    expect(signal?.threadId).toBe("t2");
    expect(signal?.precededByThreadId).toBe("t1");
    expect(signal?.subject).toBe("Onboarding timeline");
    expect(signal?.precedingSubject).toBe("Pricing for Q1");
  });

  it("never re-fires on a thread it has already seen", () => {
    const before = relationship([], [thread("t1", "Pricing", null), thread("t2", "Onboarding timeline", "t1")]);
    const after = relationship([], [thread("t1", "Pricing", null), thread("t2", "Onboarding timeline", "t1")]);
    expect(detectThreadFork(before, after)).toBeNull();
  });
});
