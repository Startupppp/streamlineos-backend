export interface Clock {
  now(): Date;
}

export const SYSTEM_CLOCK: Clock = { now: () => new Date() };

export interface GrantTransitions {
  roleAssignmentExpiry: Date | null;
  delegationStart: Date | null;
  delegationEnd: Date | null;
}

export const NO_TRANSITIONS: GrantTransitions = {
  roleAssignmentExpiry: null,
  delegationStart: null,
  delegationEnd: null,
};

export function earliestTransition(
  now: Date,
  transitions: GrantTransitions,
): Date | null {
  const cutoff = now.getTime();
  let earliest: Date | null = null;
  for (const candidate of [
    transitions.roleAssignmentExpiry,
    transitions.delegationStart,
    transitions.delegationEnd,
  ]) {
    if (candidate === null) continue;
    if (candidate.getTime() <= cutoff) continue;
    if (earliest === null || candidate.getTime() < earliest.getTime())
      earliest = candidate;
  }
  return earliest;
}

export function snapshotValidUntil(
  now: Date,
  ceilingMs: number,
  transitions: GrantTransitions,
): number {
  const ceiling = now.getTime() + ceilingMs;
  const transition = earliestTransition(now, transitions);
  if (transition === null) return ceiling;
  return Math.min(ceiling, transition.getTime());
}
