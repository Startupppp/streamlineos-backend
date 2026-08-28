import { SEAM_BUDGETS, getSeam, listSeams } from './seam-budgets';

describe('SEAM_BUDGETS', () => {
  it('every threshold is strictly below its budget', () => {
    for (const seam of listSeams()) {
      expect(seam.thresholdMs).toBeLessThan(seam.budgetMs);
    }
  });

  it('the three DB sub-allocations sum to at most db.roundtrip.simple', () => {
    const sum =
      SEAM_BUDGETS['db.pool.wait'].budgetMs +
      SEAM_BUDGETS['db.guc.setup'].budgetMs +
      SEAM_BUDGETS['db.query.execute'].budgetMs;
    expect(sum).toBeLessThanOrEqual(SEAM_BUDGETS['db.roundtrip.simple'].budgetMs);
  });

  it('every key is unique', () => {
    const keys = listSeams().map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('getSeam returns the correct definition by key', () => {
    expect(getSeam('cache.roundtrip').budgetMs).toBe(2);
    expect(getSeam('cache.roundtrip').thresholdMs).toBe(1.5);
    expect(getSeam('route.write').budgetMs).toBe(500);
    expect(getSeam('route.write').thresholdMs).toBe(375);
  });

  it('each seam has a non-empty reason', () => {
    for (const seam of listSeams()) {
      expect(seam.reason.length).toBeGreaterThan(0);
    }
  });
});
