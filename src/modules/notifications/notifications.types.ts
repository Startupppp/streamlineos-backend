export interface NotificationTicketContext {
  ticketId: number;
  ticketKey: string;
  priority: string | null;
  status: string;
  type: string;
  assignee: {
    id: string;
    name: string | null;
    firstName: string | null;
    lastName: string | null;
    image: string | null;
  } | null;
}

export type NotificationCategoryValue =
  | "SECURITY"
  | "CRM"
  | "HRMS"
  | "BILLING"
  | "AI"
  | "PROJECTS"
  | "WORKFLOW"
  | "MARKETING"
  | "SYSTEM"
  | "CHAT"
  | "PAYROLL"
  | "RECRUITMENT"
  | "KNOWLEDGE"
  | "SIGN"
  | "INVENTORY"
  | "SURVEYS"
  | "CALENDAR"
  | "SUPPORT";

export interface AnnounceInput {
  id: number;
  userId: string;
  orgId: string;
  title: string;
  message: string;
  priority: string;
  category: string;
  link?: string | null;
  sourceModule?: string | null;
  eventKey?: string | null;
}

export interface CreateNotificationInput {
  orgId: string;
  userId: string;
  type?: "INFO" | "SUCCESS" | "WARNING" | "ERROR";
  priority?: "LOW" | "NORMAL" | "HIGH" | "CRITICAL";
  category?: NotificationCategoryValue;
  sourceModule?: string;
  eventKey?: string;
  entityType?: string;
  entityId?: string;
  actorUserId?: string | null;
  reason?: string;
  title: string;
  message: string;
  link?: string;
  channel?: string;
  metadata?: Record<string, unknown>;
}
