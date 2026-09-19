export function buildProjectHref(projectId: number): string {
  return `/build/${projectId}`;
}

export function buildTicketKey(
  projectKey: string | null | undefined,
  ticketNumber: number | string,
): string {
  if (projectKey) return `${projectKey}-${ticketNumber}`;
  return String(ticketNumber);
}

export function buildTicketHref(
  projectId: number | null | undefined,
  ticketKey: string,
  commentId?: number | string | null,
): string {
  if (projectId == null) return "/build";
  const base = `/build/${projectId}/tickets/${encodeURIComponent(ticketKey)}`;
  if (commentId != null && commentId !== "") return `${base}?comment=${commentId}`;
  return base;
}

export function buildTicketBoardHref(projectId: number, ticketId: number): string {
  return `/build/${projectId}?ticket=${ticketId}`;
}

export function buildSprintListHref(projectId: number): string {
  return `/build/${projectId}/sprints`;
}

export function buildReleaseListHref(projectId: number): string {
  return `/build/${projectId}/releases`;
}

export function buildIncidentHref(projectId: number, incidentId: number): string {
  return `/build/${projectId}/incidents/${incidentId}`;
}

export function buildFeedbucketHref(
  projectId: number | null | undefined,
  submissionId: number,
): string {
  if (projectId == null) return "/build";
  return `/build/${projectId}/feedbucket/${submissionId}`;
}
