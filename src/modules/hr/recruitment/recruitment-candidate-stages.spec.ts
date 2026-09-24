import {
  APPLICATION_STATUS_FOR_STAGE,
  STAGE_TRANSITIONS,
  legalPathBetween,
} from "./recruitment-candidate-stages";

describe("legalPathBetween", () => {
  it("is empty when the candidate is already there", () => {
    expect(legalPathBetween("HIRED", "HIRED")).toEqual([]);
  });

  it("walks the board's own edges from NEW to HIRED", () => {
    expect(legalPathBetween("NEW", "HIRED")).toEqual([
      "SCREENING",
      "INTERVIEW",
      "OFFER",
      "HIRED",
    ]);
  });

  it("is one hop from OFFER, the stage an accepted offer normally comes from", () => {
    expect(legalPathBetween("OFFER", "HIRED")).toEqual(["HIRED"]);
  });

  /**
   * The one edge out of `REJECTED` is the re-open to `SCREENING`. A rejected
   * candidate who is later hired must go through it, not around it.
   */
  it("routes a re-opened candidate through the single REJECTED edge", () => {
    expect(legalPathBetween("REJECTED", "HIRED")).toEqual([
      "SCREENING",
      "INTERVIEW",
      "OFFER",
      "HIRED",
    ]);
  });

  it("returns null when the map has no route — nothing leaves HIRED", () => {
    expect(legalPathBetween("HIRED", "SCREENING")).toBeNull();
    expect(STAGE_TRANSITIONS.HIRED).toEqual([]);
  });

  it("every route it returns is made only of legal transitions", () => {
    const stages = Object.keys(STAGE_TRANSITIONS) as (keyof typeof STAGE_TRANSITIONS)[];
    for (const from of stages)
      for (const to of stages) {
        const path = legalPathBetween(from, to);
        if (path === null || path.length === 0) continue;
        let cursor = from;
        for (const next of path) {
          expect(STAGE_TRANSITIONS[cursor]).toContain(next);
          cursor = next;
        }
        expect(cursor).toBe(to);
      }
  });
});

describe("APPLICATION_STATUS_FOR_STAGE", () => {
  it("leaves NEW alone — an application is APPLIED the moment it exists", () => {
    expect(APPLICATION_STATUS_FOR_STAGE.NEW).toBeUndefined();
  });

  it("maps every other stage to the status the candidate sees on their tracking page", () => {
    expect(APPLICATION_STATUS_FOR_STAGE).toMatchObject({
      SCREENING: "SHORTLISTED",
      INTERVIEW: "INTERVIEWING",
      OFFER: "OFFERED",
      HIRED: "ACCEPTED",
      REJECTED: "REJECTED",
    });
  });
});
