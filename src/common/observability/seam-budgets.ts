export type SeamKey =
  | 'db.pool.wait'
  | 'db.guc.setup'
  | 'db.query.execute'
  | 'db.roundtrip.simple'
  | 'db.roundtrip.complex'
  | 'cache.roundtrip'
  | 'route.cached.read'
  | 'route.write';

export interface SeamBudget {
  readonly key: SeamKey;
  readonly budgetMs: number;
  readonly thresholdMs: number;
  readonly reason: string;
}

type SeamTable = Readonly<Record<SeamKey, SeamBudget>>;

export const SEAM_BUDGETS: SeamTable = {
  'db.pool.wait': {
    key: 'db.pool.wait',
    budgetMs: 5,
    thresholdMs: 3,
    reason: 'Allocation within the 20 ms round-trip budget for pool acquisition; threshold fires alert at 25% headroom before the objective is breached.',
  },
  'db.guc.setup': {
    key: 'db.guc.setup',
    budgetMs: 3,
    thresholdMs: 2,
    reason: 'Allocation within the 20 ms round-trip budget for the single set_config statement that arms tenant isolation; threshold is 25% below budget.',
  },
  'db.query.execute': {
    key: 'db.query.execute',
    budgetMs: 12,
    thresholdMs: 9,
    reason: 'Allocation within the 20 ms round-trip budget for the application query after pool acquisition and GUC setup; threshold is 25% below budget.',
  },
  'db.roundtrip.simple': {
    key: 'db.roundtrip.simple',
    budgetMs: 20,
    thresholdMs: 15,
    reason: 'PRD p95 simple tenant PostgreSQL round trip including pool wait, network, GUC setup and query execution; threshold is 25% below budget.',
  },
  'db.roundtrip.complex': {
    key: 'db.roundtrip.complex',
    budgetMs: 50,
    thresholdMs: 37,
    reason: 'PRD p95 bounded complex read; threshold is 26% below budget — the nearest whole ms at 25% headroom.',
  },
  'cache.roundtrip': {
    key: 'cache.roundtrip',
    budgetMs: 2,
    thresholdMs: 1.5,
    reason: 'PRD p95 same-region Redis operation including network; threshold is 25% below budget.',
  },
  'route.cached.read': {
    key: 'route.cached.read',
    budgetMs: 150,
    thresholdMs: 112,
    reason: 'PRD p95 browser-visible cached read; threshold is ~25% below budget — nearest whole ms.',
  },
  'route.write': {
    key: 'route.write',
    budgetMs: 500,
    thresholdMs: 375,
    reason: 'PRD p95 transactional write excluding declared async work; threshold is exactly 25% below budget.',
  },
} as const;

export function getSeam(key: SeamKey): SeamBudget {
  return SEAM_BUDGETS[key];
}

export function listSeams(): readonly SeamBudget[] {
  return Object.values(SEAM_BUDGETS);
}
