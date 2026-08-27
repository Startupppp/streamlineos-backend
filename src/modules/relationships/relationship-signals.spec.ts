import { detectRelationshipSignals } from "./relationship-signals";
import type {
  RelationshipParticipantState,
  RelationshipState,
} from "./relationship-state";

const AT = new Date("2026-08-27T12:00:00.000Z");
const d = (iso: string) => new Date(iso);

function participant(
  over: Partial<RelationshipParticipantState> & { identity: string },
): RelationshipParticipantState {
  return {
    partyId: null,
    userId: null,
    address: null,
    roles: [],
    firstSeenAt: d("2026-08-01T00:00:00.000Z"),
    lastSeenAt: d("2026-08-20T00:00:00.000Z"),
    messageCount: 5,
    repliedCount: 0,
    lastRepliedAt: null,
    ...over,
  };
}

function state(over: Partial<RelationshipState> = {}): RelationshipState {
  return {
    observedFrom: d("2026-08-01T00:00:00.000Z"),
    lastContactAt: d("2026-08-20T00:00:00.000Z"),
    lastInboundAt: d("2026-08-20T00:00:00.000Z"),
    lastOutboundAt: d("2026-08-19T00:00:00.000Z"),
    lastInboundActivityId: "a1",
    lastOutboundActivityId: "a0",
    awaitingReplySince: null,
    contactCount: 10,
    inboundCount: 5,
    outboundCount: 5,
    unreadableDirectionCount: 0,
    // A day and a half at p90: this relationship replies within about a day.
    replyLatency: { p50Seconds: 43_200, p90Seconds: 129_600, minSeconds: 3_600, maxSeconds: 172_800, sampleCount: 8 },
    participants: [],
    threads: [],
    ...over,
  };
}

const kinds = (s: ReturnType<typeof detectRelationshipSignals>) => s.map((x) => x.kind).sort();

/*
  Criterion 5 asks for an evaluation gate "including cases where the right answer
  is to do nothing". Those cases are first here on purpose: a detector that fires
  on every message is worse than one that never fires, because the first is
  switched off within a week and the second is at least honest about it.
*/
describe("relationship signals — the answer is usually nothing", () => {
  it("says nothing when nothing changed", () => {
    const champion = participant({
      identity: "party:1",
      repliedCount: 4,
      lastRepliedAt: d("2026-08-27T11:00:00.000Z"),
    });
    const s = state({ participants: [champion] });

    expect(detectRelationshipSignals({ previous: s, current: s, at: AT })).toEqual([]);
  });

  it("does not call somebody quiet who never replied in the first place", () => {
    const lurker = participant({ identity: "party:2", repliedCount: 0, lastRepliedAt: null });
    const s = state({ participants: [lurker] });

    expect(detectRelationshipSignals({ previous: s, current: s, at: AT })).toEqual([]);
  });

  it("does not call a slow relationship quiet, because the baseline is its own", () => {
    // Replied 3 days ago. That is late for a same-day relationship and ordinary
    // for a fortnightly one, and only the second is described here.
    const slow = participant({
      identity: "party:3",
      repliedCount: 6,
      lastRepliedAt: d("2026-08-24T12:00:00.000Z"),
    });
    const fortnightly = state({
      replyLatency: { p50Seconds: 604_800, p90Seconds: 1_209_600, minSeconds: 86_400, maxSeconds: 1_814_400, sampleCount: 9 },
      participants: [slow],
    });

    expect(detectRelationshipSignals({ previous: fortnightly, current: fortnightly, at: AT })).toEqual([]);
  });

  it("says nothing about silence when there is no baseline to judge against", () => {
    const p = participant({
      identity: "party:4",
      repliedCount: 2,
      lastRepliedAt: d("2026-01-01T00:00:00.000Z"),
    });
    const noBaseline = state({
      replyLatency: { p50Seconds: null, p90Seconds: null, minSeconds: null, maxSeconds: null, sampleCount: 0 },
      participants: [p],
    });

    // Silent for months, and still nothing: an unknown is not a silence.
    expect(detectRelationshipSignals({ previous: noBaseline, current: noBaseline, at: AT })).toEqual([]);
  });

  it("treats a Re: reply as the same thread, not a fork", () => {
    const previous = state({
      threads: [
        { threadId: "t1", subject: "Renewal", firstSeenAt: d("2026-08-01T00:00:00.000Z"), lastSeenAt: d("2026-08-02T00:00:00.000Z"), messageCount: 2, lastDirection: "inbound", precededByThreadId: null },
      ],
    });
    const current = state({
      threads: [
        ...previous.threads,
        { threadId: "t2", subject: "Re: Renewal", firstSeenAt: d("2026-08-03T00:00:00.000Z"), lastSeenAt: d("2026-08-03T00:00:00.000Z"), messageCount: 1, lastDirection: "inbound", precededByThreadId: "t1" },
      ],
    });

    expect(detectRelationshipSignals({ previous, current, at: AT })).toEqual([]);
  });
});

describe("relationship signals — what is worth noticing", () => {
  it("notices a champion going quiet while procurement starts replying", () => {
    const championBefore = participant({ identity: "party:champion", repliedCount: 9, lastRepliedAt: d("2026-08-20T12:00:00.000Z") });
    const procurementBefore = participant({ identity: "party:procurement", repliedCount: 0 });

    const championAfter = participant({ identity: "party:champion", repliedCount: 9, lastRepliedAt: d("2026-08-20T12:00:00.000Z") });
    const procurementAfter = participant({ identity: "party:procurement", repliedCount: 11, lastRepliedAt: d("2026-08-27T09:00:00.000Z") });

    const signals = detectRelationshipSignals({
      previous: state({ participants: [championBefore, procurementBefore] }),
      current: state({ participants: [championAfter, procurementAfter] }),
      at: AT,
    });

    expect(kinds(signals)).toEqual(["participant.replier-changed", "participant.went-quiet"]);
    const quiet = signals.find((s) => s.kind === "participant.went-quiet")!;
    expect(quiet.evidence.identity).toBe("party:champion");
    const moved = signals.find((s) => s.kind === "participant.replier-changed")!;
    expect(moved.evidence.from).toBe("party:champion");
    expect(moved.evidence.to).toBe("party:procurement");
  });

  it("records a new participant with the evidence for it", () => {
    const signals = detectRelationshipSignals({
      previous: state({ participants: [] }),
      current: state({ participants: [participant({ identity: "party:new", roles: ["procurement"] })] }),
      at: AT,
    });

    expect(kinds(signals)).toEqual(["participant.arrived"]);
    expect(signals[0]!.evidence.roles).toBe("procurement");
  });

  it("proposes a fork when the subject genuinely changes, and never applies it", () => {
    const previous = state({
      threads: [
        { threadId: "t1", subject: "Renewal", firstSeenAt: d("2026-08-01T00:00:00.000Z"), lastSeenAt: d("2026-08-02T00:00:00.000Z"), messageCount: 4, lastDirection: "inbound", precededByThreadId: null },
      ],
    });
    const current = state({
      threads: [
        ...previous.threads,
        { threadId: "t2", subject: "Second site rollout", firstSeenAt: d("2026-08-05T00:00:00.000Z"), lastSeenAt: d("2026-08-05T00:00:00.000Z"), messageCount: 1, lastDirection: "inbound", precededByThreadId: "t1" },
      ],
    });

    const signals = detectRelationshipSignals({ previous, current, at: AT });
    expect(kinds(signals)).toEqual(["thread.forked"]);

    // Criterion 3: the original deal's history does not move on its own. A fork
    // is a proposal, so its class must be `hold` and never `instant`.
    expect(signals[0]!.reversibility).toBe("hold");
    expect(signals[0]!.evidence.precededByThreadId).toBe("t1");
  });

  it("carries a reversibility class on every signal it emits", () => {
    const previous = state({ participants: [] });
    const current = state({ participants: [participant({ identity: "party:x" })] });

    for (const signal of detectRelationshipSignals({ previous, current, at: AT })) {
      expect(["instant", "hold"]).toContain(signal.reversibility);
      expect(signal.summary.length).toBeGreaterThan(0);
    }
  });
});
