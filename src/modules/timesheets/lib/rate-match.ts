export interface RateCandidate {
  projectId: number | null;
  userId: string | null;
  taskId: number | null;
  clientId: number | null;
  priority: number;
  id: number;
}

export interface RateMatchQuery {
  projectId?: number | null;
  userId?: string | null;
  ticketId?: number | null;
  taskId?: number | null;
  clientId?: number | null;
}

export function pickBestRate<T extends RateCandidate>(rates: T[], query: RateMatchQuery): T | null {
  const candidates = rates.filter((r) => {
    if (r.projectId !== null && r.projectId !== query.projectId) return false;
    if (r.userId !== null && r.userId !== query.userId) return false;
    if (r.taskId !== null && r.taskId !== (query.taskId ?? query.ticketId)) return false;
    if (r.clientId !== null && r.clientId !== query.clientId) return false;
    return true;
  });

  if (candidates.length === 0) return null;

  const scored = candidates.map((r) => {
    let score = 0;
    if (r.projectId !== null) score++;
    if (r.userId !== null) score++;
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
