export const TRIAL_GRANT_MILLI = 100_000;

export const PLAN_GRANT_MAP: Record<string, number> = {
  STARTER: 500,
  PROFESSIONAL: 2000,
  ENTERPRISE: 10000,
};

export function planGrantMilli(plan: string): number {
  const credits = PLAN_GRANT_MAP[plan] ?? 0;
  return credits * 1000;
}
