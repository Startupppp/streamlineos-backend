import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PARTY_FREQUENCY_CAPS,
  type SendTimeFacts,
} from "../../autonomy/send-guardrails";
import {
  evaluateSequenceTick,
  readStepConfig,
  SEQUENCE_HOLD_SECONDS,
  stepSends,
  STEP_CONFIG_KEYS,
  type EnrollmentFacts,
} from "./sequence-step";

const MONDAY_11AM = new Date("2026-03-02T11:00:00.000Z");
const ENROLLED = new Date("2026-03-01T09:00:00.000Z");

const enrollment = (over: Partial<EnrollmentFacts> = {}): EnrollmentFacts => ({
  now: MONDAY_11AM,
  sequenceActive: true,
  repliedAt: null,
  enrolledAt: ENROLLED,
  converted: false,
  stepType: "email",
  ...over,
});

const send = (over: Partial<SendTimeFacts> = {}): SendTimeFacts => ({
  now: MONDAY_11AM,
  outboundClass: "follow_up",
  consent: "OPTED_IN",
  consentExpiresAt: null,
  suppressed: false,
  classStopped: false,
  recentSendsToParty: [],
  partyTimezone: "Europe/London",
  tenantTimezone: "Europe/London",
  repliedAt: null,
  draftedAt: MONDAY_11AM,
  dealState: "open",
  deferralsSoFar: 0,
  ...over,
});

/*
  The fifth criterion, and the behaviour that was configurable, switched on, and
  did nothing: `evaluateStopOn` warned "stopOn key not supported" for `replied`
  and sent the next message anyway.
*/
describe("a reply exits the sequence, before anything else is considered", () => {
  it("exits on a reply that arrived after enrolment", () => {
    const tick = evaluateSequenceTick(
      enrollment({ repliedAt: new Date("2026-03-01T15:00:00.000Z") }),
      send(),
    );
    expect(tick).toEqual({ kind: "exit", reason: "replied" });
  });

  it("exits before the step is even looked at", () => {
    /*
      "Immediately, before the next step is evaluated" is stronger than blocking
      the send. A guardrail block would stop one message and leave the enrollment
      active, so the step after it would go out next Tuesday — to somebody who
      answered a fortnight ago.
    */
    const tick = evaluateSequenceTick(
      enrollment({ repliedAt: new Date("2026-03-01T15:00:00.000Z"), stepType: null }),
      null,
    );
    expect(tick).toEqual({ kind: "exit", reason: "replied" });
  });

  it("exits on a reply even while the sequence is otherwise perfectly sendable", () => {
    const sendable = evaluateSequenceTick(enrollment(), send());
    expect(sendable.kind).toBe("hold-send");

    const replied = evaluateSequenceTick(
      enrollment({ repliedAt: new Date("2026-03-02T10:59:59.000Z") }),
      send(),
    );
    expect(replied).toEqual({ kind: "exit", reason: "replied" });
  });

  it("does not treat a message stored in the same millisecond as a reply to it", () => {
    // Matches `outbound-eligibility.ts` and `send-guardrails.ts`: an inbound
    // message timestamped at the enrolment instant is what triggered it.
    expect(evaluateSequenceTick(enrollment({ repliedAt: ENROLLED }), send()).kind).toBe(
      "hold-send",
    );
  });

  it("exits rather than skipping when the reply lands between the two snapshots", () => {
    /*
      The race. The enrollment snapshot was clean; by the time the send snapshot
      was taken the reply had arrived, so the guardrails report `reply-arrived`.
      Treating that as a skipped step would leave the enrollment alive and
      produce exactly the behaviour the criterion forbids, one week later.
    */
    const tick = evaluateSequenceTick(
      enrollment(),
      send({ repliedAt: new Date("2026-03-02T10:59:00.000Z"), draftedAt: ENROLLED }),
    );
    expect(tick).toEqual({ kind: "exit", reason: "replied" });
  });
});

describe("every step goes through the guardrails every other loop uses", () => {
  it("sends through a hold rather than straight out", () => {
    // The first criterion: each send individually stoppable. A send with no
    // window cannot be stopped by anybody.
    const tick = evaluateSequenceTick(enrollment(), send());
    expect(tick).toEqual({ kind: "hold-send", holdSeconds: SEQUENCE_HOLD_SECONDS });
    expect(SEQUENCE_HOLD_SECONDS).toBeGreaterThan(0);
  });

  it("checks consent at send time, not at enrolment", () => {
    /*
      Second criterion. Somebody who opted out after step one must not receive
      step two — and would have, under an implementation that copied a consent
      flag onto the enrollment when it was created.
    */
    expect(evaluateSequenceTick(enrollment(), send({ consent: "OPTED_OUT" }))).toEqual({
      kind: "exit",
      reason: "unsubscribed",
    });
    expect(
      evaluateSequenceTick(
        enrollment(),
        send({ consentExpiresAt: new Date("2026-03-01T00:00:00.000Z") }),
      ),
    ).toEqual({ kind: "exit", reason: "unsubscribed" });
  });

  it("shares the frequency cap with every other loop rather than having its own", () => {
    /*
      Third criterion. The cap is consulted over `recentSendsToParty`, which is
      every send from every loop — so a sequence step and a follow-up cannot both
      fire in the same window, and neither loop can be "correct" in isolation
      while the recipient gets two messages.
    */
    const recent = [new Date("2026-03-01T10:00:00.000Z")];
    expect(PARTY_FREQUENCY_CAPS[0]!.max).toBe(1);
    expect(evaluateSequenceTick(enrollment(), send({ recentSendsToParty: recent }))).toEqual({
      kind: "skip-step",
      reason: "frequency-cap",
    });
  });

  it("defers a step outside working hours rather than sending or dropping it", () => {
    // Fourth criterion. Saturday morning in the recipient's own zone.
    const saturday = new Date("2026-03-07T09:00:00.000Z");
    const tick = evaluateSequenceTick(
      enrollment({ now: saturday }),
      send({ now: saturday, draftedAt: saturday }),
    );
    expect(tick.kind).toBe("defer");
    if (tick.kind === "defer") expect(tick.notBefore.getTime()).toBeGreaterThan(saturday.getTime());
  });

  it("exits on a permanent fact about the recipient, and skips on a temporary one", () => {
    /*
      The distinction that keeps a dead enrollment from being re-evaluated every
      week: an opt-out will still be true next Tuesday, a closed window will not.
    */
    expect(evaluateSequenceTick(enrollment(), send({ suppressed: true })).kind).toBe("exit");
    expect(evaluateSequenceTick(enrollment(), send({ dealState: "won" })).kind).toBe("exit");
    expect(evaluateSequenceTick(enrollment(), send({ classStopped: true }))).toEqual({
      kind: "skip-step",
      reason: "class-stopped",
    });
  });

  it("does not put a guardrail in front of a step that sends nothing", () => {
    // A task for a human reaches no customer, so there is nothing to guard —
    // and pretending otherwise would let a frequency cap block somebody's
    // to-do list.
    expect(evaluateSequenceTick(enrollment({ stepType: "call_task" }), null)).toEqual({
      kind: "internal-step",
    });
    expect(stepSends("email")).toBe(true);
    expect(stepSends("wait")).toBe(false);
  });

  it("treats an unrecognised step type as sending, which is the safe direction", () => {
    // A sending step mistaken for internal would leave the guardrails behind.
    // The reverse costs a task an unnecessary guardrail check.
    expect(stepSends("sms")).toBe(true);
    expect(() => evaluateSequenceTick(enrollment({ stepType: "sms" }), null)).toThrow(
      /needs a send-time snapshot/,
    );
  });
});

describe("a sequence cannot be configured to bypass a guardrail", () => {
  it("reads only the keys it declares out of a free-form config column", () => {
    /*
      Sixth criterion. `crm_sequence_steps.config` is unstructured JSONB, so a
      bypass would never arrive as a schema change anybody reviews — it arrives
      as `if (cfg.ignoreWorkingHours)` in the runner and a new key in a column
      that accepts anything.
    */
    const hostile = {
      to: "someone@example.com",
      subject: "hello",
      ignoreWorkingHours: true,
      skipConsent: true,
      bypassFrequencyCap: true,
      holdSeconds: 0,
      force: true,
    };
    expect(Object.keys(readStepConfig(hostile))).toEqual(["to", "subject"]);
  });

  it("declares no key that could name a guardrail", () => {
    const guardrailShaped = /consent|hold|cap|frequency|working|hours|bypass|force|skip|ignore|override/i;
    for (const key of STEP_CONFIG_KEYS) expect(key).not.toMatch(guardrailShaped);
  });

  it("has no override reaching the guardrails from anywhere in this module", () => {
    /*
      The structural half: the decision function takes an enrollment and a
      send-time snapshot, and nothing else. There is no parameter through which a
      sequence's configuration could reach `evaluateGuardrails`, so an override
      has nowhere to be threaded even by somebody trying.
    */
    expect(evaluateSequenceTick.length).toBe(2);

    const source = readFileSync(join(__dirname, "sequence-step.ts"), "utf8");
    // The guardrail call takes the snapshot alone — no merged options object.
    expect(source).toContain("evaluateGuardrails(send)");
    expect(source).not.toMatch(/evaluateGuardrails\([^)]*,/);
  });

  it("keeps the hold window inside the range the database accepts", () => {
    expect(SEQUENCE_HOLD_SECONDS).toBeGreaterThanOrEqual(10);
    expect(SEQUENCE_HOLD_SECONDS).toBeLessThanOrEqual(86_400);
  });
});

describe("the sequence ends when it should end", () => {
  it("exits when the person became a customer", () => {
    expect(evaluateSequenceTick(enrollment({ converted: true }), send())).toEqual({
      kind: "exit",
      reason: "converted",
    });
  });

  it("exits when somebody switched the sequence off", () => {
    expect(evaluateSequenceTick(enrollment({ sequenceActive: false }), send())).toEqual({
      kind: "exit",
      reason: "sequence-switched-off",
    });
  });

  it("exits when it has run out of steps", () => {
    expect(evaluateSequenceTick(enrollment({ stepType: null }), null)).toEqual({
      kind: "exit",
      reason: "completed",
    });
  });

  it("refuses to decide a sending step without a snapshot, rather than silently skipping", () => {
    // Skipping would advance the sequence having sent nothing, which looks like
    // it worked. Throwing makes the caller's omission visible where it happened.
    expect(() => evaluateSequenceTick(enrollment(), null)).toThrow(
      /needs a send-time snapshot/,
    );
  });
});
