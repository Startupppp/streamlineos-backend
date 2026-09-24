import { and, eq, sql, type SQL } from "drizzle-orm";
import {
  broadcasts,
  type BroadcastAudience,
  type BroadcastAudienceShape,
} from "../../../db/schema";

export type AnnouncementTargetType = "ALL" | "DEPARTMENT" | "BRANCH" | "ROLE";
export type AnnouncementStatus =
  | "DRAFT"
  | "SCHEDULED"
  | "PUBLISHED"
  | "EXPIRED";
export type BroadcastStatus = typeof broadcasts.$inferSelect.status;
export type BroadcastAudienceKind = "USER" | "ROLE" | "DEPARTMENT";

export interface OrgAnnouncementWrite {
  title: string;
  content: string;
  targetType: AnnouncementTargetType;
  status: AnnouncementStatus;
  isPinned: boolean;
  attachmentUrls: string[];
  publishAt: Date | null;
  expiresAt: Date | null;
}

export const ANNOUNCEMENT_COLUMNS = {
  id: broadcasts.id,
  orgId: broadcasts.orgId,
  title: broadcasts.title,
  message: broadcasts.message,
  audience: broadcasts.audience,
  status: broadcasts.status,
  scheduledAt: broadcasts.scheduledAt,
  expiresAt: broadcasts.expiresAt,
  isPinned: broadcasts.isPinned,
  createdBy: broadcasts.createdBy,
  createdAt: broadcasts.createdAt,
  updatedAt: broadcasts.updatedAt,
};

export interface AnnouncementRow {
  id: number;
  orgId: string;
  title: string;
  message: string;
  audience: BroadcastAudience;
  status: BroadcastStatus;
  scheduledAt: Date | null;
  expiresAt: Date | null;
  isPinned: boolean;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface AnnouncementResponse {
  id: number;
  orgId: string;
  title: string;
  content: string;
  authorId: string;
  targetType: AnnouncementTargetType;
  isPinned: boolean;
  publishAt: Date | null;
  expiresAt: Date | null;
  status: AnnouncementStatus;
  readCount: number;
  attachmentUrls: string[];
  createdAt: Date;
  updatedAt: Date;
  targetIds: string[];
}

export function audienceTypeFor(
  targetType: AnnouncementTargetType,
): BroadcastAudienceShape {
  const mapping: Record<AnnouncementTargetType, BroadcastAudienceShape> = {
    ALL: "all",
    DEPARTMENT: "departments",
    ROLE: "roles",
    BRANCH: "users",
  };
  return mapping[targetType];
}

export function audienceKindFor(
  targetType: AnnouncementTargetType,
): BroadcastAudienceKind | null {
  const mapping: Record<AnnouncementTargetType, BroadcastAudienceKind | null> =
    {
      ALL: null,
      DEPARTMENT: "DEPARTMENT",
      ROLE: "ROLE",
      BRANCH: "USER",
    };
  return mapping[targetType];
}

export function broadcastStatusFor(
  status: AnnouncementStatus,
): BroadcastStatus {
  const mapping: Record<AnnouncementStatus, BroadcastStatus> = {
    DRAFT: "DRAFT",
    SCHEDULED: "SCHEDULED",
    PUBLISHED: "SENT",
    EXPIRED: "SENT",
  };
  return mapping[status];
}

export function announcementStatusFor(
  status: BroadcastStatus,
  expiresAt: Date | null,
  now: Date,
): AnnouncementStatus {
  switch (status) {
    case "SCHEDULED":
    case "QUEUED":
    case "SENDING":
      return "SCHEDULED";
    case "SENT":
      return expiresAt !== null && expiresAt.getTime() <= now.getTime()
        ? "EXPIRED"
        : "PUBLISHED";
    case "DRAFT":
    case "CANCELLED":
    case "FAILED":
      return "DRAFT";
  }
}

export function buildAudience(
  targetType: AnnouncementTargetType,
  requestedIds: string[],
  recipientUserIds: string[],
  attachmentUrls: string[],
): BroadcastAudience {
  const audience: BroadcastAudience = {
    type: audienceTypeFor(targetType),
    orgAnnouncement: { targetType, targetIds: requestedIds, attachmentUrls },
  };
  if (targetType === "DEPARTMENT") audience.departmentIds = requestedIds;
  if (targetType === "ROLE") audience.roleIds = requestedIds;
  if (targetType === "BRANCH") audience.userIds = recipientUserIds;
  return audience;
}

export function orgAnnouncementScope(): SQL {
  return sql`${broadcasts.audience} -> 'orgAnnouncement' IS NOT NULL`;
}

export function orgAnnouncementRowScope(orgId: string, id: number): SQL {
  return sql`${and(eq(broadcasts.orgId, orgId), eq(broadcasts.id, id), orgAnnouncementScope())}`;
}

export function projectAnnouncement(
  row: AnnouncementRow,
  readCount: number,
  now: Date,
): AnnouncementResponse {
  const meta = row.audience.orgAnnouncement;
  return {
    id: row.id,
    orgId: row.orgId,
    title: row.title,
    content: row.message,
    authorId: row.createdBy,
    targetType: meta?.targetType ?? "ALL",
    isPinned: row.isPinned,
    publishAt: row.scheduledAt,
    expiresAt: row.expiresAt,
    status: announcementStatusFor(row.status, row.expiresAt, now),
    readCount,
    attachmentUrls: meta?.attachmentUrls ?? [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    targetIds: meta?.targetIds ?? [],
  };
}
