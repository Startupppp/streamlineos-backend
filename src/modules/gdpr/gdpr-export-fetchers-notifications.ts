import { and, asc, eq, gt } from "drizzle-orm";
import {
  mailMessageMetadata,
  notificationDeliveries,
  notificationPreferences,
  notificationReadWatermarks,
  notifications,
  organizationMembers,
} from "../../db/schema";
import type { Db } from "../../db/drizzle.module";
import { BATCH_SIZE } from "./gdpr-export-types";

export async function fetchMail(
  db: Db,
  orgId: string,
  userId: string,
  afterId?: number,
) {
  const conditions = [
    eq(mailMessageMetadata.orgId, orgId),
    eq(organizationMembers.userId, userId),
  ];
  if (afterId !== undefined)
    conditions.push(gt(mailMessageMetadata.id, afterId));
  return db
    .select({
      id: mailMessageMetadata.id,
      messageId: mailMessageMetadata.messageId,
      threadId: mailMessageMetadata.threadId,
      subject: mailMessageMetadata.subject,
      senderEmail: mailMessageMetadata.senderEmail,
      senderName: mailMessageMetadata.senderName,
      date: mailMessageMetadata.date,
      isRead: mailMessageMetadata.isRead,
      isStarred: mailMessageMetadata.isStarred,
      labels: mailMessageMetadata.labels,
      folder: mailMessageMetadata.folder,
      hasAttachment: mailMessageMetadata.hasAttachment,
      syncedAt: mailMessageMetadata.syncedAt,
    })
    .from(mailMessageMetadata)
    .innerJoin(
      organizationMembers,
      and(
        eq(mailMessageMetadata.orgId, organizationMembers.orgId),
        eq(mailMessageMetadata.userMembershipId, organizationMembers.id),
      ),
    )
    .where(and(...conditions))
    .orderBy(asc(mailMessageMetadata.id))
    .limit(BATCH_SIZE);
}

export async function fetchNotifications(
  db: Db,
  orgId: string,
  userId: string,
  afterId?: number,
) {
  const conditions = [
    eq(notifications.orgId, orgId),
    eq(organizationMembers.userId, userId),
  ];
  if (afterId !== undefined) conditions.push(gt(notifications.id, afterId));
  return db
    .select({
      id: notifications.id,
      createdAt: notifications.createdAt,
      type: notifications.type,
      priority: notifications.priority,
      category: notifications.category,
      sourceModule: notifications.sourceModule,
      entityType: notifications.entityType,
      entityId: notifications.entityId,
      reason: notifications.reason,
      title: notifications.title,
      message: notifications.message,
      link: notifications.link,
      isRead: notifications.isRead,
      pinned: notifications.pinned,
      channel: notifications.channel,
      archivedAt: notifications.archivedAt,
      deletedAt: notifications.deletedAt,
    })
    .from(notifications)
    .innerJoin(
      organizationMembers,
      and(
        eq(notifications.orgId, organizationMembers.orgId),
        eq(notifications.membershipId, organizationMembers.id),
      ),
    )
    .where(and(...conditions))
    .orderBy(asc(notifications.id))
    .limit(BATCH_SIZE);
}

export async function fetchNotificationReadWatermarks(
  db: Db,
  orgId: string,
  userId: string,
  afterId?: number,
) {
  const conditions = [
    eq(notificationReadWatermarks.orgId, orgId),
    eq(notificationReadWatermarks.userId, userId),
  ];
  if (afterId !== undefined)
    conditions.push(gt(notificationReadWatermarks.id, afterId));
  return db
    .select({
      id: notificationReadWatermarks.id,
      membershipId: notificationReadWatermarks.membershipId,
      lastReadNotificationId: notificationReadWatermarks.lastReadNotificationId,
      updatedAt: notificationReadWatermarks.updatedAt,
    })
    .from(notificationReadWatermarks)
    .where(and(...conditions))
    .orderBy(asc(notificationReadWatermarks.id))
    .limit(BATCH_SIZE);
}

export async function fetchNotificationDeliveries(
  db: Db,
  orgId: string,
  userId: string,
  afterId?: number,
) {
  const conditions = [
    eq(notificationDeliveries.orgId, orgId),
    eq(notificationDeliveries.userId, userId),
  ];
  if (afterId !== undefined)
    conditions.push(gt(notificationDeliveries.id, afterId));
  return db
    .select({
      id: notificationDeliveries.id,
      notificationId: notificationDeliveries.notificationId,
      eventKey: notificationDeliveries.eventKey,
      channel: notificationDeliveries.channel,
      status: notificationDeliveries.status,
      sentAt: notificationDeliveries.sentAt,
      deliveredAt: notificationDeliveries.deliveredAt,
      readAt: notificationDeliveries.readAt,
      clickedAt: notificationDeliveries.clickedAt,
      failedAt: notificationDeliveries.failedAt,
      failureCode: notificationDeliveries.failureCode,
      renderedSubject: notificationDeliveries.renderedSubject,
      renderedBody: notificationDeliveries.renderedBody,
      createdAt: notificationDeliveries.createdAt,
      updatedAt: notificationDeliveries.updatedAt,
    })
    .from(notificationDeliveries)
    .where(and(...conditions))
    .orderBy(asc(notificationDeliveries.id))
    .limit(BATCH_SIZE);
}

export async function fetchNotificationPreferences(
  db: Db,
  orgId: string,
  userId: string,
  afterId?: number,
) {
  const conditions = [
    eq(notificationPreferences.orgId, orgId),
    eq(notificationPreferences.userId, userId),
  ];
  if (afterId !== undefined)
    conditions.push(gt(notificationPreferences.id, afterId));
  return db
    .select({
      id: notificationPreferences.id,
      membershipId: notificationPreferences.membershipId,
      emailEnabled: notificationPreferences.emailEnabled,
      pushEnabled: notificationPreferences.pushEnabled,
      smsEnabled: notificationPreferences.smsEnabled,
      inAppEnabled: notificationPreferences.inAppEnabled,
      whatsappEnabled: notificationPreferences.whatsappEnabled,
      soundEnabled: notificationPreferences.soundEnabled,
      quietHoursStart: notificationPreferences.quietHoursStart,
      quietHoursEnd: notificationPreferences.quietHoursEnd,
      categories: notificationPreferences.categories,
      channelCategories: notificationPreferences.channelCategories,
      eventPreferences: notificationPreferences.eventPreferences,
      modulePreferences: notificationPreferences.modulePreferences,
      createdAt: notificationPreferences.createdAt,
      updatedAt: notificationPreferences.updatedAt,
    })
    .from(notificationPreferences)
    .where(and(...conditions))
    .orderBy(asc(notificationPreferences.id))
    .limit(BATCH_SIZE);
}
