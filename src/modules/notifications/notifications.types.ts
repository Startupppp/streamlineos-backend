import { notificationCategoryEnum } from "../../db/schema/common/enums";

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

export type NotificationCategoryValue = (typeof notificationCategoryEnum.enumValues)[number];

export function isNotificationCategory(value: string): value is NotificationCategoryValue {
  return notificationCategoryEnum.enumValues.some((v) => v === value);
}

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

/**
 * One notification as the list query selects it.
 *
 * Lives here rather than beside the query because `notification-ticket-context`
 * enriches these rows and the query calls that enrichment — declaring the row
 * in either file closes an import cycle over a type that compiles away.
 */
export type NotificationListRow = {
  id: number;
  orgId: string;
  userId: string | null;
  type: string;
  priority: string;
  category: string;
  sourceModule: string | null;
  eventKey: string | null;
  entityType: string | null;
  entityId: string | null;
  reason: string | null;
  title: string;
  message: string;
  link: string | null;
  isRead: boolean;
  pinned: boolean;
  channel: string;
  metadata: Record<string, unknown> | null;
  archivedAt: Date | null;
  snoozedUntil: Date | null;
  createdAt: Date;
};
