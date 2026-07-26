import { pickBestRate, type RateCandidate } from "./rate-match";

function rate(partial: Partial<RateCandidate> & { id: number }): RateCandidate {
  return {
    projectId: null,
    userId: null,
    taskId: null,
    clientId: null,
    priority: 0,
    effectiveFrom: null,
    effectiveTo: null,
    ...partial,
  };
}

describe("pickBestRate effective dating", () => {
  const rates = [
    rate({ id: 1, projectId: 10, effectiveFrom: "2026-01-01", effectiveTo: "2026-06-30" }),
    rate({ id: 2, projectId: 10, effectiveFrom: "2026-07-01", effectiveTo: null }),
    rate({ id: 3, projectId: 10, effectiveFrom: null, effectiveTo: null, priority: -1 }),
  ];

  it("picks the rate effective on the entry date (old window)", () => {
    const best = pickBestRate(rates, { projectId: 10, date: "2026-03-15" });
    // ties on specificity: id 1 and 3 both match; higher priority wins is 1 (0 > -1)
    expect(best?.id).toBe(1);
  });

  it("picks the successor rate after the changeover date", () => {
    const best = pickBestRate(rates, { projectId: 10, date: "2026-07-01" });
    expect(best?.id).toBe(2);
  });

  it("excludes rates whose window has not started", () => {
    const best = pickBestRate([rates[1]!], { projectId: 10, date: "2026-06-30" });
    expect(best).toBeNull();
  });

  it("excludes rates whose window has ended", () => {
    const best = pickBestRate([rates[0]!], { projectId: 10, date: "2026-07-01" });
    expect(best).toBeNull();
  });

  it("ignores effective windows when no date is supplied (backward compatible)", () => {
    const best = pickBestRate(rates, { projectId: 10 });
    // all three match; ids 1 and 2 tie on priority, newest id wins
    expect(best?.id).toBe(2);
  });

  it("open-ended windows match any date on or after start", () => {
    const best = pickBestRate([rates[1]!], { projectId: 10, date: "2030-01-01" });
    expect(best?.id).toBe(2);
  });
});
