import type { ScreeningQuestion } from "../../db/schema/hr/hiring-core";
import { evaluateScreening } from "./careers-screening";

const question = (over: Partial<ScreeningQuestion> = {}): ScreeningQuestion => ({
  id: "q1",
  question: "Do you have a work permit?",
  type: "YES_NO",
  required: true,
  knockout: true,
  knockoutAnswer: "Yes",
  ...over,
});

describe("evaluateScreening", () => {
  it("accepts when every required question is answered and no knockout fires", () => {
    expect(evaluateScreening([question()], { q1: "Yes" })).toEqual({
      outcome: "accepted",
      answers: { q1: "Yes" },
    });
  });

  it("matches the knockout answer case-insensitively and ignoring surrounding space", () => {
    expect(evaluateScreening([question()], { q1: "  yes " })).toEqual({
      outcome: "accepted",
      answers: { q1: "yes" },
    });
  });

  it("knocks out an answer that is not the required one", () => {
    const verdict = evaluateScreening([question()], { q1: "No" });
    expect(verdict.outcome).toBe("knocked-out");
    if (verdict.outcome !== "knocked-out") throw new Error("expected a knockout");
    expect(verdict.question).toBe("Do you have a work permit?");
    expect(verdict.reason).toContain("Do you have a work permit?");
  });

  it("names every unanswered required question rather than only the first", () => {
    const verdict = evaluateScreening(
      [
        question({ id: "q1", question: "Work permit?" }),
        question({ id: "q2", question: "Notice period?", type: "TEXT", knockout: false }),
      ],
      {},
    );
    expect(verdict).toEqual({ outcome: "missing", questions: ["Work permit?", "Notice period?"] });
  });

  it("lets an optional question go unanswered", () => {
    expect(
      evaluateScreening([question({ required: false, knockout: false })], {}),
    ).toEqual({ outcome: "accepted", answers: {} });
  });

  /**
   * A knockout with no required answer is a half-configured question. Firing on
   * it would reject every applicant to that job and look like the form is
   * broken, so it is treated as not-a-knockout.
   */
  it("never fires a knockout that states no required answer", () => {
    expect(
      evaluateScreening([question({ knockoutAnswer: undefined })], { q1: "No" }),
    ).toEqual({ outcome: "accepted", answers: { q1: "No" } });
    expect(evaluateScreening([question({ knockoutAnswer: "   " })], { q1: "No" })).toEqual({
      outcome: "accepted",
      answers: { q1: "No" },
    });
  });

  /**
   * The answers column is a public write target on an unauthenticated route.
   * Keeping only keys the job declares stops it being free storage for anyone
   * who can reach the form.
   */
  it("drops answers to questions the job does not ask", () => {
    expect(evaluateScreening([question({ knockout: false })], { q1: "Yes", junk: "x".repeat(50) })).toEqual({
      outcome: "accepted",
      answers: { q1: "Yes" },
    });
    expect(evaluateScreening(null, { junk: "x" })).toEqual({ outcome: "accepted", answers: {} });
  });

  it("truncates a stored answer rather than accepting unbounded text", () => {
    const verdict = evaluateScreening([question({ type: "TEXT", knockout: false })], {
      q1: "a".repeat(5000),
    });
    if (verdict.outcome !== "accepted") throw new Error("expected acceptance");
    expect(verdict.answers.q1).toHaveLength(2000);
  });
});
