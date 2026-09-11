import {
  CALL_ANALYSIS_PRIVATE_WINDOW_HOURS,
  callAnalysisOpensAt,
  callAnalysisVisibility,
  canReleaseCallAnalysis,
  type CallAnalysisSubject,
} from "./call-analysis-visibility";

/**
 * The visibility rule is the ticket, so the rule is what is on trial.
 *
 * These are not "does the function return an object" tests. Each one names a way
 * the feature turns from a coaching tool into a surveillance report, and asserts
 * that the rule refuses it:
 *
 *   - a rep locked out of their own call because somebody edited their role;
 *   - a manager reading an analysis the rep has not seen;
 *   - an org owner exempt from the window, which makes the window advisory;
 *   - a colleague with no claim on the call learning when it opens, which is a
 *     timing oracle over who analysed what;
 *   - consent to one analyser silently covering the next one's judgement.
 *
 * `now` is a parameter of the rule, so every boundary below is asserted at the
 * millisecond rather than approximated with a sleep.
 */

const REP = "user-rep";
const MANAGER = "user-manager";
const BYSTANDER = "user-bystander";

const ANALYSED_AT = new Date("2026-08-20T09:00:00.000Z");
const WINDOW_MS = CALL_ANALYSIS_PRIVATE_WINDOW_HOURS * 60 * 60 * 1000;
const OPENS_AT = new Date(ANALYSED_AT.getTime() + WINDOW_MS);

const subject = (over: Partial<CallAnalysisSubject> = {}): CallAnalysisSubject => ({
  repUserId: REP,
  analysedAt: ANALYSED_AT,
  analyzerVersion: 1,
  release: null,
  ...over,
});

const at = (msFromAnalysis: number): Date => new Date(ANALYSED_AT.getTime() + msFromAnalysis);

describe("the rep sees their own analysis first", () => {
  it("shows a rep their own call the instant it exists", () => {
    const decision = callAnalysisVisibility(
      { userId: REP, canReadTeam: false },
      subject(),
      ANALYSED_AT,
    );

    expect(decision).toEqual({ visible: true, reason: "own-call", opensAt: null });
  });

  /**
   * The rep branch is evaluated before the team-key branch, and this is the
   * assertion that pins the order. If they were swapped, a rep who is also
   * somebody's manager would read their own call as a manager — same answer
   * today, but the moment an administrator edited that person's role the answer
   * to "may I read my own call" would change. The rule promises it does not.
   */
  it("answers 'own-call' for a rep who also holds the team key, not 'window-elapsed'", () => {
    const decision = callAnalysisVisibility(
      { userId: REP, canReadTeam: true },
      subject(),
      ANALYSED_AT,
    );

    expect(decision.visible).toBe(true);
    expect(decision.reason).toBe("own-call");
  });
});

describe("everybody else waits", () => {
  it("hides it from a manager while the rep's window is open, and says when it opens", () => {
    const decision = callAnalysisVisibility(
      { userId: MANAGER, canReadTeam: true },
      subject(),
      at(WINDOW_MS - 1),
    );

    expect(decision).toEqual({ visible: false, reason: "rep-window", opensAt: OPENS_AT });
  });

  /**
   * The boundary, at the millisecond. A strict `>` would leave one millisecond
   * in which the analysis is neither embargoed nor open by the stated rule, and
   * no clock in the system can distinguish that instant from its neighbours —
   * so the property is asserted rather than left to whichever comparison was
   * typed first.
   */
  it("opens exactly on the tick, not a millisecond earlier", () => {
    const justBefore = callAnalysisVisibility(
      { userId: MANAGER, canReadTeam: true },
      subject(),
      at(WINDOW_MS - 1),
    );
    const onTheTick = callAnalysisVisibility(
      { userId: MANAGER, canReadTeam: true },
      subject(),
      at(WINDOW_MS),
    );

    expect(justBefore.visible).toBe(false);
    expect(onTheTick).toEqual({ visible: true, reason: "window-elapsed", opensAt: null });
    expect(callAnalysisOpensAt(ANALYSED_AT)).toEqual(OPENS_AT);
  });

  /**
   * `canReadTeam` is what `AccessService.scopeFor` answers, and it answers
   * "all" for an org owner on every key. So an owner arrives here as a manager
   * and waits. If this ever fails, the window has become a delay the one person
   * most likely to be asked to "just check" can skip, and no rep has reason to
   * believe in it.
   */
  it("binds an org owner exactly as it binds any other manager", () => {
    const owner = callAnalysisVisibility(
      { userId: "user-owner", canReadTeam: true },
      subject(),
      at(60_000),
    );

    expect(owner.visible).toBe(false);
    expect(owner.reason).toBe("rep-window");
  });

  /**
   * A bystander is refused WITHOUT a time. Handing them `opensAt` would tell
   * somebody with no claim on the call that an analysis of it exists and when it
   * becomes readable — a fact about a colleague's work, leaked through an error
   * response.
   */
  it("tells a colleague with no team key nothing about the timing", () => {
    const decision = callAnalysisVisibility(
      { userId: BYSTANDER, canReadTeam: false },
      subject(),
      at(WINDOW_MS + 60_000),
    );

    expect(decision).toEqual({ visible: false, reason: "not-your-call", opensAt: null });
  });
});

describe("the rep can hand it over early", () => {
  it("opens it to a manager the moment the rep releases it", () => {
    const decision = callAnalysisVisibility(
      { userId: MANAGER, canReadTeam: true },
      subject({ release: { analyzerVersion: 1, releasedAt: at(1000) } }),
      at(2000),
    );

    expect(decision).toEqual({ visible: true, reason: "released", opensAt: null });
  });

  /**
   * Consent does not carry forward across an analyser bump. The rep released a
   * judgement they had read; version 2 is a different judgement of the same
   * call, produced by a prompt they have never seen. Without this check, editing
   * the prompt would publish a fresh paragraph about somebody on the strength of
   * consent they gave to a different one.
   */
  it("does not let a release of version 1 publish version 2", () => {
    const decision = callAnalysisVisibility(
      { userId: MANAGER, canReadTeam: true },
      subject({ analyzerVersion: 2, release: { analyzerVersion: 1, releasedAt: at(1000) } }),
      at(2000),
    );

    expect(decision.visible).toBe(false);
    expect(decision.reason).toBe("rep-window");
  });

  /** A release timestamped in the future — clock skew between nodes — is not yet a release. */
  it("ignores a release that has not happened yet", () => {
    const decision = callAnalysisVisibility(
      { userId: MANAGER, canReadTeam: true },
      subject({ release: { analyzerVersion: 1, releasedAt: at(5000) } }),
      at(4999),
    );

    expect(decision.visible).toBe(false);
  });

  it("lets only the rep release, whatever anybody else holds", () => {
    expect(canReleaseCallAnalysis({ userId: REP, canReadTeam: false }, { repUserId: REP })).toBe(
      true,
    );
    expect(
      canReleaseCallAnalysis({ userId: MANAGER, canReadTeam: true }, { repUserId: REP }),
    ).toBe(false);
    // Nobody is the rep, so nobody can release. The window governs instead.
    expect(
      canReleaseCallAnalysis({ userId: MANAGER, canReadTeam: true }, { repUserId: null }),
    ).toBe(false);
  });
});

/**
 * The honest gap, asserted so it is a decision rather than a surprise.
 *
 * The ingress workflow writes every adapter-delivered call with
 * `actor_kind: 'system'` and no user, so those calls have no rep. An embargo
 * would protect nobody and would lock out the person who was actually on the
 * call — they hold `crm:call-analysis:view` and not `view-team`, so no branch
 * would ever open it for them. Attribution is the precondition of the
 * protection; where there is none, there is none.
 */
describe("a call nobody is attributed to", () => {
  it("is readable, and says so by name rather than pretending to be protected", () => {
    const decision = callAnalysisVisibility(
      { userId: BYSTANDER, canReadTeam: false },
      subject({ repUserId: null }),
      ANALYSED_AT,
    );

    expect(decision).toEqual({ visible: true, reason: "unattributed", opensAt: null });
  });
});
