import {
  buildFunnel,
  offerAcceptRate,
  percentiles,
  sourcePerformance,
  toCsv,
} from "./funnel-math";

describe("buildFunnel", () => {
  const stages = [
    { stage: "Applied", count: 200 },
    { stage: "Screened", count: 80 },
    { stage: "Interviewed", count: 20 },
    { stage: "Offered", count: 5 },
    { stage: "Hired", count: 4 },
  ];

  it("computes conversion from the previous stage and from the top", () => {
    const funnel = buildFunnel(stages);
    expect(funnel[1]).toMatchObject({ conversionFromPrevious: 40, conversionFromTop: 40 });
    expect(funnel[2]).toMatchObject({ conversionFromPrevious: 25, conversionFromTop: 10 });
    expect(funnel[4]).toMatchObject({ conversionFromPrevious: 80, conversionFromTop: 2 });
  });

  it("leaves the first stage with no conversion, because there is nothing above it", () => {
    const funnel = buildFunnel(stages);
    expect(funnel[0]?.conversionFromPrevious).toBeNull();
    expect(funnel[0]?.conversionFromTop).toBeNull();
  });

  /**
   * The case that decides whether this dashboard is trustworthy. "Nobody
   * converted" and "there was nobody to convert" are different facts, and
   * rendering the second as 0% tells a recruiter their screening is broken when
   * they simply have no applicants.
   */
  it("reports null, not zero, when the previous stage was empty", () => {
    const funnel = buildFunnel([
      { stage: "Applied", count: 0 },
      { stage: "Screened", count: 0 },
    ]);
    expect(funnel[1]?.conversionFromPrevious).toBeNull();
    expect(funnel[1]?.conversionFromTop).toBeNull();
  });

  it("still reports a real zero when people arrived and none converted", () => {
    const funnel = buildFunnel([
      { stage: "Applied", count: 50 },
      { stage: "Screened", count: 0 },
    ]);
    expect(funnel[1]?.conversionFromPrevious).toBe(0);
  });

  it("handles an empty funnel without throwing", () => {
    expect(buildFunnel([])).toEqual([]);
  });

  it("keeps one decimal place", () => {
    const funnel = buildFunnel([
      { stage: "Applied", count: 3 },
      { stage: "Screened", count: 1 },
    ]);
    expect(funnel[1]?.conversionFromPrevious).toBe(33.3);
  });
});

describe("percentiles", () => {
  it("reports median, p90 and mean", () => {
    const stats = percentiles([10, 20, 30, 40, 100]);
    expect(stats).toMatchObject({ count: 5, median: 30, p90: 100, mean: 40 });
  });

  /**
   * Every hiring distribution has one requisition that stayed open for a year,
   * and it drags the mean far enough to make planning numbers wrong. Keeping
   * both is what makes the gap visible.
   */
  it("keeps the median stable when one outlier moves the mean", () => {
    const withOutlier = percentiles([10, 12, 14, 16, 3650]);
    expect(withOutlier.median).toBe(14);
    expect(withOutlier.mean).toBeGreaterThan(700);
  });

  /** Whole days. "22.5 days to fill" is a number no requisition took. */
  it("returns a real observation for an even-sized sample, not an average", () => {
    expect(percentiles([10, 20, 30, 40]).median).toBe(30);
  });

  it("reports nulls rather than NaN for an empty sample", () => {
    expect(percentiles([])).toEqual({ count: 0, median: null, p90: null, mean: null });
  });

  it("drops values that are not finite", () => {
    expect(percentiles([10, Number.NaN, 20]).count).toBe(2);
  });

  it("handles a single observation", () => {
    expect(percentiles([7])).toEqual({ count: 1, median: 7, p90: 7, mean: 7 });
  });
});

describe("sourcePerformance", () => {
  it("computes a hire rate per source", () => {
    const rows = sourcePerformance([{ source: "LINKEDIN", applicants: 40, hires: 4 }]);
    expect(rows[0]?.hireRate).toBe(10);
  });

  it("reports null for a source nobody applied from", () => {
    const rows = sourcePerformance([{ source: "CAMPUS", applicants: 0, hires: 0 }]);
    expect(rows[0]?.hireRate).toBeNull();
  });

  /**
   * A source with one applicant and one hire has a 100% rate and tells nobody
   * anything. Sorting by rate would put it above a source that produced twenty
   * hires, which makes the table actively misleading at a glance.
   */
  it("sorts by hires, not by rate", () => {
    const rows = sourcePerformance([
      { source: "REFERRAL", applicants: 1, hires: 1 },
      { source: "CAREERS_PAGE", applicants: 500, hires: 20 },
    ]);
    expect(rows[0]?.source).toBe("CAREERS_PAGE");
  });

  it("breaks a tie on hires by applicant volume", () => {
    const rows = sourcePerformance([
      { source: "A", applicants: 10, hires: 2 },
      { source: "B", applicants: 100, hires: 2 },
    ]);
    expect(rows[0]?.source).toBe("B");
  });
});

describe("offerAcceptRate", () => {
  it("computes over answered offers", () => {
    expect(offerAcceptRate(8, 2)).toBe(80);
  });

  /**
   * Outstanding offers are excluded from the denominator. Counting them as
   * declines makes the rate fall every time a new offer goes out and rise when
   * it is accepted — volatility in candidate behaviour that is really just the
   * passage of time.
   */
  it("is null when no offer has been answered", () => {
    expect(offerAcceptRate(0, 0)).toBeNull();
  });

  it("is zero when every answered offer was declined", () => {
    expect(offerAcceptRate(0, 3)).toBe(0);
  });
});

describe("toCsv", () => {
  it("quotes every field and doubles inner quotes", () => {
    expect(toCsv(["a"], [['say "hi"']])).toBe('"a"\r\n"say ""hi"""');
  });

  it("keeps a comma inside a field", () => {
    expect(toCsv(["a"], [["Bengaluru, India"]])).toBe('"a"\r\n"Bengaluru, India"');
  });

  it("writes an empty string for null", () => {
    expect(toCsv(["a"], [[null]])).toBe('"a"\r\n""');
  });

  /**
   * A source label or a candidate-supplied string beginning with one of these
   * is executable content once the file is opened in a spreadsheet. The leading
   * quote neutralises it without changing what a person reads in the cell.
   */
  it.each(["=cmd|'/c calc'!A1", "+1-555", "-2+3", "@SUM(A1)"])(
    "neutralises the formula prefix in %s",
    (value) => {
      const csv = toCsv(["a"], [[value]]);
      expect(csv).toContain(`"'${value}"`);
    },
  );

  it("leaves an ordinary value alone", () => {
    expect(toCsv(["a"], [["LINKEDIN"]])).toBe('"a"\r\n"LINKEDIN"');
  });

  it("writes CRLF between rows, which is what spreadsheets expect", () => {
    expect(toCsv(["a"], [["1"], ["2"]]).split("\r\n")).toHaveLength(3);
  });
});
