import { BUG_PRIORITY_VALUES, bugSeverityEnum, bugStatusEnum } from "../../../../db/schema/build/qa";
import { stateGroupEnum, ticketPriorityEnum } from "../../../../db/schema/common/enums";

export type BugStatus = (typeof bugStatusEnum.enumValues)[number];
export type BugSeverity = (typeof bugSeverityEnum.enumValues)[number];
export type BugPriority = (typeof BUG_PRIORITY_VALUES)[number];
export type StateGroup = (typeof stateGroupEnum.enumValues)[number];
export type TicketPriority = (typeof ticketPriorityEnum.enumValues)[number];

export const UNRESOLVED_STATE_GROUP: StateGroup = "backlog";
export const UNRESOLVED_TICKET_PRIORITY: TicketPriority = "MEDIUM";
export const UNTYPED_PROJECT_STATUS_GROUP: StateGroup = "unstarted";

export const BUG_STATUS_TO_STATE_GROUP: Readonly<Record<BugStatus, StateGroup>> = Object.freeze({
  new: "backlog",
  triaged: "unstarted",
  assigned: "unstarted",
  in_progress: "started",
  fixed: "started",
  ready_for_qa: "started",
  verified: "completed",
  reopened: "started",
  closed: "completed",
});

export const STATE_GROUP_FALLBACK_CHAIN: Readonly<Record<StateGroup, readonly StateGroup[]>> =
  Object.freeze({
    backlog: ["backlog", "unstarted", "started", "completed", "cancelled"],
    unstarted: ["unstarted", "backlog", "started", "completed", "cancelled"],
    started: ["started", "unstarted", "backlog", "completed", "cancelled"],
    completed: ["completed", "started", "unstarted", "backlog", "cancelled"],
    cancelled: ["cancelled", "completed", "started", "unstarted", "backlog"],
  });

export const BUG_PRIORITY_TO_TICKET_PRIORITY: Readonly<Record<BugPriority, TicketPriority>> =
  Object.freeze({
    low: "LOW",
    medium: "MEDIUM",
    high: "HIGH",
    urgent: "URGENT",
  });

export const BUG_SEVERITY_TO_SUGGESTED_PRIORITY: Readonly<Record<BugSeverity, TicketPriority>> =
  Object.freeze({
    blocker: "URGENT",
    critical: "HIGH",
    major: "MEDIUM",
    minor: "LOW",
    trivial: "LOW",
  });

export function resolveStateGroup(value: string | null | undefined): StateGroup {
  if (value === null || value === undefined) return UNRESOLVED_STATE_GROUP;
  const mapped = (BUG_STATUS_TO_STATE_GROUP as Record<string, StateGroup | undefined>)[value];
  return mapped ?? UNRESOLVED_STATE_GROUP;
}

export function resolveTicketPriority(value: string | null | undefined): TicketPriority {
  if (value === null || value === undefined) return UNRESOLVED_TICKET_PRIORITY;
  const mapped = (BUG_PRIORITY_TO_TICKET_PRIORITY as Record<string, TicketPriority | undefined>)[
    value
  ];
  return mapped ?? UNRESOLVED_TICKET_PRIORITY;
}

export function resolveSuggestedPriorityFromSeverity(
  value: string | null | undefined,
): TicketPriority {
  if (value === null || value === undefined) return UNRESOLVED_TICKET_PRIORITY;
  const mapped = (
    BUG_SEVERITY_TO_SUGGESTED_PRIORITY as Record<string, TicketPriority | undefined>
  )[value];
  return mapped ?? UNRESOLVED_TICKET_PRIORITY;
}

export interface ProjectStatusCandidate {
  id: number;
  name: string;
  order: number;
  type: StateGroup | null;
}

export const SEEDED_FALLBACK_PROJECT_STATUSES: readonly ProjectStatusCandidate[] = Object.freeze([
  { id: 0, name: "TODO", order: 0, type: "unstarted" },
  { id: 1, name: "IN_PROGRESS", order: 1, type: "started" },
  { id: 2, name: "IN_REVIEW", order: 2, type: "started" },
  { id: 3, name: "DONE", order: 3, type: "completed" },
]);

export function effectiveStateGroup(candidate: ProjectStatusCandidate): StateGroup {
  return candidate.type ?? UNTYPED_PROJECT_STATUS_GROUP;
}

export function resolveProjectStatusName(
  target: StateGroup,
  available: readonly ProjectStatusCandidate[],
): string {
  const pool = available.length > 0 ? available : SEEDED_FALLBACK_PROJECT_STATUSES;
  for (const group of STATE_GROUP_FALLBACK_CHAIN[target]) {
    const matches = pool
      .filter((candidate) => effectiveStateGroup(candidate) === group)
      .sort((a, b) => (a.order !== b.order ? a.order - b.order : a.id - b.id));
    const first = matches[0];
    if (first !== undefined) return first.name;
  }
  const ordered = [...pool].sort((a, b) => (a.order !== b.order ? a.order - b.order : a.id - b.id));
  return ordered[0]!.name;
}

export function resolveWorkItemStatus(
  bugStatus: string | null | undefined,
  available: readonly ProjectStatusCandidate[],
): string {
  return resolveProjectStatusName(resolveStateGroup(bugStatus), available);
}

