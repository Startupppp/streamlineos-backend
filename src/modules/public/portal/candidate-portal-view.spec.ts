import {
  assertNoLeak,
  PORTAL_STATUS_COPY,
  PORTAL_STATUSES,
  PortalLeakError,
  toPortalStatus,
} from "./candidate-portal-view";

describe("toPortalStatus", () => {
  it("maps every internal status to a coarse one", () => {
    const mapped = {
      APPLIED: "received",
      SHORTLISTED: "in_review",
      INTERVIEWING: "interview",
      OFFERED: "offer",
      ACCEPTED: "hired",
      REJECTED: "rejected",
      WITHDRAWN: "rejected",
    } as const;
    for (const [internal, portal] of Object.entries(mapped)) {
      expect(toPortalStatus(internal)).toBe(portal);
    }
  });

  /**
   * The one that matters. SHORTLISTED is good news and the most tempting state
   * to expose, and exposing it means its absence is information too — a
   * candidate watching a peer's status change and not their own has been told
   * where they stand by a system that never said anything.
   */
  it("never tells a candidate they were shortlisted", () => {
    expect(toPortalStatus("SHORTLISTED")).toBe("in_review");
    expect(toPortalStatus("SHORTLISTED")).not.toBe("received");
  });

  it("never emits an internal spelling", () => {
    for (const internal of ["APPLIED", "SHORTLISTED", "INTERVIEWING", "OFFERED", "ACCEPTED", "REJECTED", "WITHDRAWN"]) {
      expect(PORTAL_STATUSES).toContain(toPortalStatus(internal));
    }
  });

  /**
   * An unknown value is most likely a later pipeline state, so the vaguer
   * answer is the safe one: "being reviewed" is true of every intermediate
   * state, while "received" would tell a candidate at offer stage that nothing
   * has happened.
   */
  it("falls back to in_review, not received, for a status it does not know", () => {
    expect(toPortalStatus("SOME_FUTURE_STATE")).toBe("in_review");
    expect(toPortalStatus("")).toBe("in_review");
  });

  it("has copy for every coarse status", () => {
    for (const status of PORTAL_STATUSES) {
      expect(PORTAL_STATUS_COPY[status].length).toBeGreaterThan(5);
    }
  });
});

describe("assertNoLeak", () => {
  const good = {
    status: "in_review",
    statusText: "Your application is being reviewed.",
    appliedAt: new Date(),
    updatedAt: new Date(),
    jobTitle: "Engineer",
    jobLocation: "Bengaluru",
    jobType: "FULL_TIME",
    organisationName: "Acme",
    candidateFirstName: "Jane",
    bookingUrl: null,
    offerUrl: null,
  };

  it("passes the response the portal actually builds", () => {
    expect(() => assertNoLeak(good)).not.toThrow();
  });

  /**
   * The exact failure this guards: a relation widened to `true` to fix a
   * missing name, pulling the rest of the candidate row onto a public,
   * unauthenticated endpoint.
   */
  it.each([
    "notes",
    "internalNotes",
    "aiScore",
    "rating",
    "feedback",
    "rubric",
    "bgvNotes",
    "salaryExpectation",
    "transcript",
    "candidateEmail",
    "phone",
    "trackingToken",
    "inboundSecret",
  ])("throws when %s reaches the response", (key) => {
    expect(() => assertNoLeak({ ...good, [key]: "anything" })).toThrow(PortalLeakError);
  });

  it("throws for a field that is merely unexpected, not only a named one", () => {
    expect(() => assertNoLeak({ ...good, candidateId: 7 })).toThrow(PortalLeakError);
  });

  /**
   * A throw rather than a strip. Silently removing the field would let the
   * mistake live in the code and stop it reaching only this one endpoint.
   */
  it("names the offending field so the fix is obvious", () => {
    expect(() => assertNoLeak({ ...good, bgvNotes: "x" })).toThrow(/bgvNotes/);
  });

  it("accepts a response with the two action links filled in", () => {
    expect(() =>
      assertNoLeak({ ...good, bookingUrl: "/interview-booking/abc", offerUrl: "/offer/def" }),
    ).not.toThrow();
  });
});
