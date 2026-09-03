/**
 * Telling the channel a huddle has started.
 *
 * Every member of the channel except the person who started it is notified, read in keyset batches
 * rather than one query — a company-wide channel has tens of thousands of members and the whole
 * list has no business being in memory at once. The dispatch itself is skipped when there is nobody
 * to tell, so a solo huddle in an empty channel costs no notification work at all.
 */
import { and, asc, eq, gt } from "drizzle-orm";
import { chatChannelMembers, organizationMembers } from "../../db/schema";
import type { Db } from "../../db/drizzle.types";
import type { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import { forEachChannelMemberBatch } from "./chat-channel-member-batches";

const NOTIFY_BATCH = 500;

export interface HuddleStartedNotification {
  orgId: string;
  channelId: number;
  channelName: string;
  huddleId: number;
  actorUserId: string;
}

export async function collectHuddleNotifyTargets(
  db: Db,
  orgId: string,
  channelId: number,
  excludeUserId: string,
): Promise<string[]> {
  const targetUserIds: string[] = [];
  await forEachChannelMemberBatch(
    db,
    NOTIFY_BATCH,
    (handle, afterMembershipId) =>
      handle
        .select({ userId: organizationMembers.userId, membershipId: chatChannelMembers.membershipId })
        .from(chatChannelMembers)
        .innerJoin(organizationMembers, eq(organizationMembers.id, chatChannelMembers.membershipId))
        .where(
          and(
            eq(chatChannelMembers.orgId, orgId),
            eq(chatChannelMembers.channelId, channelId),
            afterMembershipId !== null ? gt(chatChannelMembers.membershipId, afterMembershipId) : undefined,
          ),
        )
        .orderBy(asc(chatChannelMembers.membershipId))
        .limit(NOTIFY_BATCH),
    (batch) => {
      for (const row of batch)
        if (row.userId !== excludeUserId) targetUserIds.push(row.userId);
    },
  );
  return targetUserIds;
}

export async function notifyHuddleStarted(
  db: Db,
  dispatch: NotificationDispatchService,
  input: HuddleStartedNotification,
): Promise<void> {
  const targetUserIds = await collectHuddleNotifyTargets(db, input.orgId, input.channelId, input.actorUserId);
  if (targetUserIds.length === 0) return;
  await dispatch.emit({
    eventKey: "chat.huddle.invite",
    orgId: input.orgId,
    actorUserId: input.actorUserId,
    targetUserIds,
    entityType: "channel",
    entityId: String(input.channelId),
    title: `Huddle started in #${input.channelName}`,
    message: "A huddle has started — tap to join.",
    link: `/chat?channel=${input.channelId}&joinHuddle=1`,
    variables: { channelId: input.channelId, huddleId: input.huddleId },
  });
}
