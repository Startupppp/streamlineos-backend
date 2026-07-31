import { Inject, Injectable } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { notifications, organizationMembers, organizations, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { logger } from "../../common/logger/logger.service";
import { birthdaySubject, birthdayMessage } from "../hr/lifecycle/hr-notification-texts";

interface BroadcastInput {
  type?: "INFO" | "SUCCESS" | "WARNING" | "ERROR";
  title: string;
  message: string;
  link?: string;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class CronNotificationsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async sendDailyNotifications(): Promise<{
    birthdayCount: number;
    leaveCount: number;
    anniversaryCount: number;
  }> {
    const today = new Date();
    const month = today.getMonth() + 1;
    const day = today.getDate();

    let birthdayCount = 0;
    const leaveCount = 0;
    const anniversaryCount = 0;

    const birthdayUsers = await this.db
      .select({
        id: users.id,
        name: users.name,
        firstName: users.firstName,
        lastName: users.lastName,
        email: users.email,
      })
      .from(users)
      .where(
        and(
          eq(users.isActive, true),
          sql`EXTRACT(MONTH FROM ${users.dateOfBirth}::date) = ${month}`,
          sql`EXTRACT(DAY FROM ${users.dateOfBirth}::date) = ${day}`,
        ),
      );

    if (birthdayUsers.length === 0) {
      return { birthdayCount: 0, leaveCount: 0, anniversaryCount: 0 };
    }

    for (const birthdayUser of birthdayUsers) {
      const displayName =
        birthdayUser.firstName && birthdayUser.lastName
          ? `${birthdayUser.firstName} ${birthdayUser.lastName}`
          : birthdayUser.name || birthdayUser.email;

      const memberships = await this.db
        .select({ orgId: organizationMembers.orgId, orgName: organizations.name })
        .from(organizationMembers)
        .innerJoin(organizations, eq(organizationMembers.orgId, organizations.id))
        .where(eq(organizationMembers.userId, birthdayUser.id));

      for (const membership of memberships) {
        try {
          await this.notifyAllMembers(membership.orgId, {
            type: "INFO",
            title: birthdaySubject(displayName ?? ""),
            message: birthdayMessage(displayName ?? ""),
            metadata: {
              category: "birthday",
              birthdayUserId: birthdayUser.id,
            },
          });
        } catch (error) {
          logger.error("Failed to create birthday in-app notifications", {
            userId: birthdayUser.id,
            orgId: membership.orgId,
            error,
          });
        }

        birthdayCount++;
      }
    }

    logger.info("Daily notifications processed", { birthdayCount, leaveCount, anniversaryCount });

    return { birthdayCount, leaveCount, anniversaryCount };
  }

  private async notifyAllMembers(orgId: string, opts: BroadcastInput): Promise<void> {
    const members = await this.db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(eq(organizationMembers.orgId, orgId));

    if (members.length === 0) return;

    await this.db.insert(notifications).values(
      members.map((m) => ({
        orgId,
        userId: m.userId,
        type: opts.type ?? "INFO",
        title: opts.title,
        message: opts.message,
        link: opts.link,
        metadata: opts.metadata,
      })),
    );
  }
}
