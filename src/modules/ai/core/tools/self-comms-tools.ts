import { Injectable, Inject } from "@nestjs/common";
import { and, count, desc, eq, gt, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { broadcasts, notifications } from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import {
  defineTool,
  data,
  empty,
  type AskOsToolDefinition,
  type AskOsToolProvider,
} from "../registry/ask-os-tool.types";
import { AskOsTools } from "../registry/ask-os-tools.decorator";

const INBOX_CAP = 30;
const ANNOUNCEMENTS_CAP = 20;

@AskOsTools()
@Injectable()
export class SelfCommsTools implements AskOsToolProvider {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  tools(): AskOsToolDefinition[] {
    return [
      defineTool({
        key: "getMyInbox",
        description:
          "Get the caller's own inbox notification items, most recent first. Returns up to 30 items. capped is true when the list may be truncated.",
        input: z.object({}),
        run: async (_input, ctx) => {
          const { orgId, membershipId } = ctx.actor;
          const rows = await this.db.query.notifications.findMany({
            where: and(
              eq(notifications.orgId, orgId),
              eq(notifications.membershipId, membershipId),
              isNull(notifications.deletedAt),
              isNull(notifications.archivedAt),
            ),
            orderBy: [desc(notifications.createdAt), desc(notifications.id)],
            limit: INBOX_CAP,
            columns: {
              id: true,
              type: true,
              priority: true,
              category: true,
              title: true,
              message: true,
              link: true,
              isRead: true,
              pinned: true,
              sourceModule: true,
              createdAt: true,
            },
          });
          if (rows.length === 0)
            return empty("inbox", "No notifications found.");
          return data({
            items: rows,
            total: rows.length,
            capped: rows.length === INBOX_CAP,
          });
        },
      }),

      defineTool({
        key: "getMyNotificationCount",
        description: "Get the caller's unread notification count.",
        input: z.object({}),
        run: async (_input, ctx) => {
          const { orgId, membershipId } = ctx.actor;
          const rows = await this.db
            .select({ unreadCount: count() })
            .from(notifications)
            .where(
              and(
                eq(notifications.orgId, orgId),
                eq(notifications.membershipId, membershipId),
                eq(notifications.isRead, false),
                isNull(notifications.deletedAt),
                isNull(notifications.archivedAt),
              ),
            );
          const unreadCount = Number(rows[0]?.unreadCount ?? 0);
          return data({ unreadCount });
        },
      }),

      defineTool({
        key: "getMyAnnouncements",
        description:
          "Get active published announcements visible to the caller's organisation, pinned items first. Returns up to 20 items.",
        input: z.object({}),
        run: async (_input, ctx) => {
          const { orgId } = ctx.actor;
          const now = new Date();
          const rows = await this.db
            .select({
              id: broadcasts.id,
              title: broadcasts.title,
              content: broadcasts.message,
              targetType: broadcasts.audienceType,
              isPinned: broadcasts.isPinned,
              publishAt: broadcasts.sentAt,
              createdAt: broadcasts.createdAt,
            })
            .from(broadcasts)
            .where(
              and(
                eq(broadcasts.orgId, orgId),
                eq(broadcasts.status, "SENT"),
                eq(broadcasts.audienceType, "all"),
                or(isNull(broadcasts.expiresAt), gt(broadcasts.expiresAt, now)),
              ),
            )
            .orderBy(desc(broadcasts.isPinned), desc(broadcasts.createdAt))
            .limit(ANNOUNCEMENTS_CAP);
          if (rows.length === 0)
            return empty("announcements", "No active announcements found.");
          return data({ announcements: rows });
        },
      }),
    ];
  }
}
