import {
  croston,
  exponentialSmoothing,
  movingAverage,
  naive,
  seasonalNaive,
} from "../baselines";
import { accuracy } from "../accuracy";
import { backtest, rankBaselines } from "../backtest";

describe("INV-301 deterministic baselines", () => {
  it("naive repeats the last observation", () => {
    expect(naive([3, 7, 5], 2)).toEqual([5, 5]);
  });

  it("naive answers zero for an empty history rather than NaN", () => {
    // A new SKU has no history, and NaN propagates silently into a reorder
    // quantity where it becomes a purchase order for nothing.
    expect(naive([], 1)).toEqual([0]);
  });

  it("a moving average averages only its window", () => {
    // 100 is deliberately outside the window: an average that quietly included
    // it would still look reasonable, which is why the fixture is shaped this
    // way rather than as a flat series.
    expect(movingAverage(3)([100, 2, 4, 6], 1)).toEqual([4]);
  });

  it("a moving average falls back to the whole history when it is short", () => {
    expect(movingAverage(12)([2, 4], 1)).toEqual([3]);
  });

  it("seasonal naive repeats the matching period, not the last one", () => {
    // The failure it prevents: a plain average of a weekly rhythm forecasts the
    // same number every day and destroys exactly the pattern worth having.
    const week = [1, 2, 3, 4, 5, 60, 70];
    expect(seasonalNaive(7)(week, 7)).toEqual(week);
  });

  it("seasonal naive declines to claim a season it has not seen", () => {
    // Two days of history cannot support a weekly claim, so it degrades to
    // naive rather than inventing a cycle.
    expect(seasonalNaive(7)([4, 9], 2)).toEqual([9, 9]);
  });

  it("exponential smoothing with alpha 1 is naive", () => {
    // A property worth pinning: it catches an implementation that has the
    // smoothing the wrong way round, which otherwise looks plausible.
    expect(exponentialSmoothing(1)([3, 7, 5], 1)).toEqual([5]);
  });

  it("exponential smoothing leans on recent periods", () => {
    const [value] = exponentialSmoothing(0.5)([0, 0, 10], 1);
    expect(value).toBeGreaterThan(2.5);
    expect(value).toBeLessThan(10);
  });

  describe("croston, for demand that is mostly zero", () => {
    it("forecasts a rate rather than a phantom weekly unit", () => {
      // Ten units every fifth period. A plain average says 2 per period, which
      // is never right and never obviously wrong; Croston reports roughly the
      // same rate but derived from size and interval, which is the number a
      // safety-stock calculation can reason about.
      const intermittent = [0, 0, 0, 0, 10, 0, 0, 0, 0, 10, 0, 0, 0, 0, 10];
      const [forecast] = croston(0.3)(intermittent, 1);
      expect(forecast).toBeGreaterThan(0);
      expect(forecast).toBeLessThan(10);
    });

    it("answers zero when nothing has ever been demanded", () => {
      expect(croston()([0, 0, 0], 1)).toEqual([0]);
    });
  });
});

describe("INV-301 accuracy metrics", () => {
  it("reports mae, rmse and bias separately", () => {
    // Same absolute error, opposite signs: accuracy is bad, bias is nil. A
    // single combined number would hide one of the two failures entirely.
    const metrics = accuracy([10, 10], [20, 0]);
    expect(metrics.mae).toBe(10);
    expect(metrics.rmse).toBe(10);
    expect(metrics.bias).toBe(0);
  });

  it("shows a consistently high forecast as bias", () => {
    // This is the one that silently fills a warehouse, and it has the same MAE
    // as the case above.
    const metrics = accuracy([10, 10], [15, 15]);
    expect(metrics.mae).toBe(5);
    expect(metrics.bias).toBe(5);
  });

  it("scales against the naive forecast so SKUs are comparable", () => {
    // MASE below 1 means better than assuming tomorrow equals today.
    const history = [10, 20, 10, 20, 10, 20];
    const good = accuracy([20, 10], [20, 10], history);
    const bad = accuracy([20, 10], [0, 0], history);
    expect(good.mase!).toBeLessThan(1);
    expect(bad.mase!).toBeGreaterThan(1);
  });

  it("reports MASE as unavailable on a series that never moved", () => {
    // Scaling against a naive error of zero would divide by nothing, and
    // Infinity in a report reads as a catastrophic model rather than as an
    // undefined measure.
    expect(accuracy([5], [6], [5, 5, 5]).mase).toBeNull();
  });

  it("survives an empty comparison", () => {
    expect(accuracy([], [])).toMatchObject({ n: 0, mae: 0, mase: null });
  });
});

describe("INV-301 rolling-origin backtest", () => {
  it("never lets a forecast see the period it is predicting", () => {
    // The point of the whole harness. A forecaster that peeks would score
    // perfectly here; one that cannot, cannot.
    const series = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    const peeker = (history: readonly number[]) => [history.length + 1];
    const honest = backtest(series, peeker, { minTrain: 8 });
    // history.length + 1 is exactly the next value for this series, so a
    // forecaster that only sees the past still scores zero error -- which
    // proves the harness passes the right prefix rather than the whole series.
    expect(honest.mae).toBe(0);
    expect(honest.n).toBe(4);
  });

  it("scores a flat-wrong forecaster by how wrong it is", () => {
    const series = [10, 10, 10, 10, 10, 10, 10, 10, 10, 10];
    expect(backtest(series, () => [0], { minTrain: 8 }).mae).toBe(10);
  });

  it("produces nothing when the history is shorter than the warm-up", () => {
    // Judging a method on three points is judging it on noise, so it reports
    // no result rather than a confident one.
    expect(backtest([1, 2, 3], naive, { minTrain: 8 }).n).toBe(0);
  });

  it("ranks the seasonal baseline first on seasonal data", () => {
    // Four weeks of a strong weekly rhythm. If a plain average wins here the
    // seasonal implementation is wrong.
    const week = [2, 3, 4, 5, 6, 40, 50];
    const series = [...week, ...week, ...week, ...week];
    const ranked = rankBaselines(series, { minTrain: 7 });
    expect(ranked[0]!.method).toBe("seasonal_naive_7");
  });

  it("ranks every baseline it knows about", () => {
    const ranked = rankBaselines([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], { minTrain: 8 });
    expect(ranked.map((r) => r.method)).toEqual(
      expect.arrayContaining(["naive", "croston", "exponential_smoothing"]),
    );
  });
});
