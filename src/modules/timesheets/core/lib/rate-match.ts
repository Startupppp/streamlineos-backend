export interface RateCandidate {
  projectId: number | null;
  userMembershipId: number | null;
  taskId: number | null;
  clientId: number | null;
  priority: number;
  id: number;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
}

export interface RateMatchQuery {
  projectId?: number | null;
  userMembershipId?: number | null;
  ticketId?: number | null;
  taskId?: number | null;
  clientId?: number | null;
  date?: string | null;
}

export function pickBestRate<T extends RateCandidate>(rates: T[], query: RateMatchQuery): T | null {
  const candidates = rates.filter((r) => {
    if (r.projectId !== null && r.projectId !== query.projectId) return false;
    if (r.userMembershipId !== null && r.userMembershipId !== query.userMembershipId) return false;
    if (r.taskId !== null && r.taskId !== (query.taskId ?? query.ticketId)) return false;
    if (r.clientId !== null && r.clientId !== query.clientId) return false;
    if (query.date) {
      if (r.effectiveFrom && query.date < r.effectiveFrom) return false;
      if (r.effectiveTo && query.date > r.effectiveTo) return false;
    }
    return true;
  });

  if (candidates.length === 0) return null;

  const scored = candidates.map((r) => {
    let score = 0;
    if (r.projectId !== null) score++;
    if (r.userMembershipId !== null) score++;
    if (r.taskId !== null) score++;
    if (r.clientId !== null) score++;
    return { r, score };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.r.priority !== a.r.priority) return b.r.priority - a.r.priority;
    return b.r.id - a.r.id;
  });

  return scored[0]?.r ?? null;
}
