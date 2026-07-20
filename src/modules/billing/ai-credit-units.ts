export const TRIAL_GRANT_CREDITS = 100;
export const TRIAL_GRANT_MILLI = TRIAL_GRANT_CREDITS * 1000;

export const PLAN_GRANT_MAP: Record<string, number> = {
  STARTER: 500,
  PROFESSIONAL: 2000,
  ENTERPRISE: 10000,
};

export function planGrantMilli(plan: string): number {
  const credits = PLAN_GRANT_MAP[plan] ?? 0;
  return credits * 1000;
}

export function creditsToMilliUnits(credits: number): number {
  return Math.round(credits * 1000);
}

export function milliUnitsToCredits(milli: number): number {
  return Math.round(milli) / 1000;
}
