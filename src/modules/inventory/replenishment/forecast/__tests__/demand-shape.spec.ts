import { autocorrelation, classifyDemand, detectSeasonality } from "../demand-shape";

describe("INV-302 demand classification", () => {
  it("calls regular, consistent demand smooth", () => {
    expect(classifyDemand([10, 11, 9, 10, 11, 10]).category).toBe("smooth");
  });

  it("calls regular but wildly variable demand erratic", () => {
    // Demand every period, sizes all over the place. The level is forecastable;
    // the size is not, and that belongs in safety stock rather than the forecast.
    expect(classifyDemand([1, 40, 2, 35, 3, 50]).category).toBe("erratic");
  });

  it("calls gappy demand of consistent size intermittent", () => {
    const series = [0, 0, 10, 0, 0, 10, 0, 0, 10, 0, 0, 10];
    const result = classifyDemand(series);
    expect(result.category).toBe("intermittent");
    expect(result.adi).toBe(3);
    expect(result.guidance).toMatch(/Croston/);
  });

  it("calls rare unpredictable demand lumpy, and says it is the hard case", () => {
    const series = [0, 0, 0, 2, 0, 0, 0, 0, 90, 0, 0, 0];
    const result = classifyDemand(series);
    expect(result.category).toBe("lumpy");
    expect(result.guidance).toMatch(/human review/);
  });

  it("measures variability of demand sizes, not of the whole series", () => {
    // The distinction that keeps intermittent apart from lumpy. Every gap is a
    // zero, so including zeros in the variance makes every gappy series look
    // unpredictable and the category stops carrying information.
    const consistentSizes = [0, 0, 10, 0, 0, 10, 0, 0, 10];
    expect(classifyDemand(consistentSizes).cv2).toBe(0);
  });

  it("reports no demand rather than classifying nothing", () => {
    const result = classifyDemand([0, 0, 0, 0]);
    expect(result.category).toBe("no_demand");
    expect(result.guidance).toMatch(/assertion rather than an estimate/);
  });
});

describe("INV-302 seasonality detection", () => {
  const week = [2, 3, 4, 5, 6, 40, 50];
  const seasonal = [...week, ...week, ...week, ...week];

  it("finds a weekly rhythm", () => {
    const result = detectSeasonality(seasonal);
    expect(result.seasonLength).toBe(7);
    expect(result.strength).toBeGreaterThan(0.4);
  });

  it("declines to name a season in noise", () => {
    // The failure this prevents: seasonalNaive on a non-seasonal series is
    // strictly worse than a moving average, because it propagates one period's
    // noise forward forever.
    const flat = [5, 5, 5, 6, 5, 4, 5, 5, 6, 5, 4, 5, 5, 6, 5, 4];
    expect(detectSeasonality(flat, [7], 0.4).seasonLength).toBeNull();
  });

  it("refuses to judge a season it has seen only once", () => {
    // One cycle cannot tell a season from a trend.
    expect(detectSeasonality(week, [7]).seasonLength).toBeNull();
    expect(detectSeasonality(week, [7]).candidates).toEqual([]);
  });

  it("reports every candidate it tried, so a rejection is inspectable", () => {
    const result = detectSeasonality(seasonal, [7, 4]);
    expect(result.candidates.map((c) => c.lag).sort()).toEqual([4, 7]);
  });

  it("correlates a series with itself at lag zero as no signal", () => {
    // Guards the boundary: lag 0 is meaningless and must not read as perfect
    // seasonality.
    expect(autocorrelation([1, 2, 3], 0)).toBe(0);
  });

  it("gives a flat series no autocorrelation rather than dividing by zero", () => {
    expect(autocorrelation([4, 4, 4, 4, 4, 4], 2)).toBe(0);
  });
});
