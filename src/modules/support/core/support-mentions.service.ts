import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { supportMessageMentions, users, organizationMembers } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { logger } from "../../../common/logger/logger.service";

interface OrgUser {
  id: string;
  name: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string;
}

function displayName(user: OrgUser): string {
  if (user.name && user.name.trim()) return user.name.trim();
  const full = `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim();
  if (full) return full;
  return user.email;
}

function extractMentionTokens(content: string): string[] {
  const matches = content.match(/@([\w.+-]+(?:\s+[\w.+-]+)?)/g);
  if (!matches) return [];
  return matches.map((token) => token.slice(1).trim().toLowerCase()).filter(Boolean);
}

function matchMentionedUsers(content: string, orgUsers: OrgUser[]): OrgUser[] {
  const tokens = extractMentionTokens(content);
  if (tokens.length === 0) return [];

  const matched = new Map<string, OrgUser>();
  for (const user of orgUsers) {
    const candidates = [
      user.email.toLowerCase(),
      user.email.split("@")[0]?.toLowerCase() ?? "",
      displayName(user).toLowerCase(),
      `${user.firstName ?? ""}`.toLowerCase().trim(),
    ].filter(Boolean);

    if (tokens.some((token) => candidates.includes(token))) {
      matched.set(user.id, user);
    }
  }
  return Array.from(matched.values());
}

@Injectable()
export class SupportMentionsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly dispatch: NotificationDispatchService,
  ) {}

  async processMessageMentions(input: {
    orgId: string;
    ticketId: number;
    ticketTitle: string;
    messageId: number;
    content: string;
    authorId: string | null;
    authorName: string;
  }): Promise<void> {
    if (!input.content || !input.content.includes("@")) return;

    const orgUsers = await this.db
      .select({
        id: users.id,
        name: users.name,
        firstName: users.firstName,
        lastName: users.lastName,
        email: users.email,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(eq(organizationMembers.orgId, input.orgId));

    const mentioned = matchMentionedUsers(input.content, orgUsers).filter(
      (user) => user.id !== input.authorId,
    );
    if (mentioned.length === 0) return;

    try {
      await this.db
        .insert(supportMessageMentions)
        .values(
          mentioned.map((user) => ({
            orgId: input.orgId,
            messageId: input.messageId,
            mentionedUserId: user.id,
          })),
        )
        .onConflictDoNothing();
    } catch (error) {
      logger.error("Failed to insert support message mentions", { error });
      return;
    }

    try {
      await this.dispatch.emit({
        eventKey: "support.ticket.mention",
        orgId: input.orgId,
        actorUserId: input.authorId,
        targetUserIds: mentioned.map((user) => user.id),
        entityType: "support_ticket",
        entityId: String(input.ticketId),
        title: "You were mentioned",
        message: `${input.authorName} mentioned you in an internal note on "${input.ticketTitle}".`,
        link: `/support/inbox?ticketId=${input.ticketId}`,
        metadata: { ticketId: input.ticketId, messageId: input.messageId },
      });
    } catch (error) {
      logger.error("Failed to notify mentioned users", { error });
    }
  }
}
