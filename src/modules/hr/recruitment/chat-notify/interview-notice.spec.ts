import {
  buildInterviewNotice,
  CHAT_ADAPTERS,
  noticeLeaksSomething,
  resolveChat,
  type InterviewNotice,
} from "./interview-notice";

const BASE: InterviewNotice = {
  candidateFirstName: "Jane",
  jobTitle: "Senior Engineer",
  whenText: "Tue 3 Mar, 3:00 pm IST",
  durationMinutes: 45,
  scorecardPath: "/hr/recruitment/interviews/7",
  kind: "assigned",
};

describe("buildInterviewNotice", () => {
  it("says who, what, when and where the scorecard is", () => {
    const message = buildInterviewNotice(BASE);
    expect(message).toContain("Jane");
    expect(message).toContain("Senior Engineer");
    expect(message).toContain("3:00 pm IST");
    expect(message).toContain("45 min");
    expect(message).toContain("/hr/recruitment/interviews/7");
  });

  it("changes the verb for a reschedule", () => {
    expect(buildInterviewNotice({ ...BASE, kind: "rescheduled" })).toContain("Interview moved");
  });

  /** Nothing to score for an interview that is not happening. */
  it("drops the scorecard link from a cancellation", () => {
    const message = buildInterviewNotice({ ...BASE, kind: "cancelled" });
    expect(message).toContain("Interview cancelled");
    expect(message).not.toContain("Scorecard");
  });

  /**
   * A Slack channel is readable by everyone in it, searchable forever and
   * frequently mirrored into third-party tools. Whatever goes here leaves the
   * reach of every permission this product has.
   */
  it("carries a first name and no other candidate detail", () => {
    const message = buildInterviewNotice(BASE);
    expect(noticeLeaksSomething(message)).toBeNull();
    expect(message).not.toContain("Doe");
  });

  it("would catch a surname-and-email shaped leak if one were added", () => {
    expect(noticeLeaksSomething("Interviewing jane.doe@example.com")).toBe("@");
    expect(noticeLeaksSomething("Offer at 30 LPA CTC")).toBe("ctc");
    expect(noticeLeaksSomething("Resume attached")).toBe("resume");
  });

  it("builds a notice for every kind without a placeholder", () => {
    for (const kind of ["assigned", "rescheduled", "cancelled"] as const) {
      const message = buildInterviewNotice({ ...BASE, kind });
      expect(message).not.toContain("undefined");
      expect(message.length).toBeGreaterThan(20);
    }
  });
});

describe("the chat providers", () => {
  /**
   * The mildest consequence in this lane — an interviewer is not pinged — and
   * still no stub. A swallowed post makes "notified" true in our logs and false
   * in the world, and the person who finds out is the interviewer who did not
   * turn up.
   */
  it("ships no adapter for either platform", () => {
    expect(CHAT_ADAPTERS.size).toBe(0);
  });

  it.each(["SLACK", "TEAMS"] as const)("blocks %s when nothing is connected", (platform) => {
    expect(resolveChat(platform, null)).toMatchObject({
      status: "BLOCKED",
      code: "no-integration",
    });
  });

  it("names the fallback that still reaches the interviewer", () => {
    const resolved = resolveChat("SLACK", {
      platform: "SLACK",
      isActive: true,
      token: "xoxb-something",
      meta: {},
    });
    expect(resolved).toMatchObject({ status: "BLOCKED", code: "not-implemented" });
    if ("adapter" in resolved) throw new Error("expected no adapter");
    expect(resolved.message).toContain("email and the calendar invite");
  });
});
