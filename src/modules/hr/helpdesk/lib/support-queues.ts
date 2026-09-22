export const SUPPORT_QUEUES = ["HR", "IT", "FINANCE", "ADMIN", "LEGAL"] as const;

export type SupportQueue = (typeof SUPPORT_QUEUES)[number];

export const SUPPORT_QUEUE_LABELS: Record<SupportQueue, string> = {
  HR: "HR",
  IT: "IT",
  FINANCE: "Finance",
  ADMIN: "Admin",
  LEGAL: "Legal",
};

export const HELPDESK_CATEGORIES = [
  "policy_question",
  "payroll_issue",
  "document_request",
  "leave_issue",
  "benefits",
  "it_access",
  "equipment",
  "expense_reimbursement",
  "facilities",
  "legal_query",
  "confidential",
  "other",
] as const;

export type HelpdeskCategory = (typeof HELPDESK_CATEGORIES)[number];

export const DEFAULT_CATEGORY_QUEUE: Record<HelpdeskCategory, SupportQueue> = {
  policy_question: "HR",
  payroll_issue: "FINANCE",
  document_request: "HR",
  leave_issue: "HR",
  benefits: "HR",
  it_access: "IT",
  equipment: "IT",
  expense_reimbursement: "FINANCE",
  facilities: "ADMIN",
  legal_query: "LEGAL",
  confidential: "HR",
  other: "ADMIN",
};

export interface QueueSla {
  firstResponseHours: number;
  resolutionHours: number;
}

export const DEFAULT_QUEUE_SLA: Record<SupportQueue, QueueSla> = {
  HR: { firstResponseHours: 8, resolutionHours: 72 },
  IT: { firstResponseHours: 4, resolutionHours: 24 },
  FINANCE: { firstResponseHours: 8, resolutionHours: 72 },
  ADMIN: { firstResponseHours: 8, resolutionHours: 48 },
  LEGAL: { firstResponseHours: 24, resolutionHours: 120 },
};

export const CONFIDENTIAL_BY_DEFAULT_QUEUES: ReadonlySet<SupportQueue> = new Set<SupportQueue>(["HR", "LEGAL"]);

export const SUPPORT_ADMIN_PERMISSION = "hr:helpdesk:manage";
export const SUPPORT_AGENT_PERMISSION = "hr:helpdesk:view";

export function queuePermissionKey(queue: SupportQueue): string {
  return `hr:helpdesk:queue-${queue.toLowerCase()}`;
}

export function isSupportQueue(value: string): value is SupportQueue {
  return (SUPPORT_QUEUES as readonly string[]).includes(value);
}

export function resolveQueue(
  category: HelpdeskCategory,
  override: SupportQueue | null | undefined,
): SupportQueue {
  return override ?? DEFAULT_CATEGORY_QUEUE[category];
}

export function defaultConfidentiality(queue: SupportQueue): boolean {
  return CONFIDENTIAL_BY_DEFAULT_QUEUES.has(queue);
}

const HOUR_MS = 60 * 60 * 1000;

export function stampSla(createdAt: Date, sla: QueueSla): { firstResponseDueAt: Date; slaDueAt: Date } {
  return {
    firstResponseDueAt: new Date(createdAt.getTime() + sla.firstResponseHours * HOUR_MS),
    slaDueAt: new Date(createdAt.getTime() + sla.resolutionHours * HOUR_MS),
  };
}

export type SlaBreach = "first_response" | "resolution";

export function slaBreach(
  ticket: {
    firstResponseDueAt: Date | null;
    firstRespondedAt: Date | null;
    slaDueAt: Date | null;
  },
  now: Date,
): SlaBreach | null {
  if (ticket.slaDueAt && ticket.slaDueAt.getTime() < now.getTime()) return "resolution";
  if (
    ticket.firstResponseDueAt &&
    ticket.firstRespondedAt === null &&
    ticket.firstResponseDueAt.getTime() < now.getTime()
  )
    return "first_response";
  return null;
}

export function selectEscalationTarget(
  queueEscalationUserId: string | null,
  admins: ReadonlyArray<{ userId: string }>,
  currentAssigneeId: string | null,
): string | null {
  if (queueEscalationUserId) return queueEscalationUserId;
  const other = admins.find((admin) => admin.userId !== currentAssigneeId);
  return other?.userId ?? admins[0]?.userId ?? null;
}

export interface SupportActor {
  orgId: string;
  userId: string;
  membershipId: number | null;
  isAdmin: boolean;
  queues: ReadonlySet<SupportQueue>;
}

export function memberQueues(
  held: ReadonlySet<string>,
  isAdmin: boolean,
): ReadonlySet<SupportQueue> {
  if (isAdmin) return new Set(SUPPORT_QUEUES);
  return new Set(SUPPORT_QUEUES.filter((queue) => held.has(queuePermissionKey(queue))));
}

export function canReadTicket(
  actor: SupportActor,
  ticket: { userId: string; queue: SupportQueue; isConfidential: boolean },
): boolean {
  if (ticket.userId === actor.userId) return true;
  if (actor.isAdmin) return true;
  if (actor.queues.has(ticket.queue)) return true;
  return !ticket.isConfidential;
}

export function canWorkTicket(
  actor: SupportActor,
  ticket: { queue: SupportQueue },
): boolean {
  return actor.isAdmin || actor.queues.has(ticket.queue);
}
