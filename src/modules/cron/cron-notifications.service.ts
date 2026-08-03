import { Inject, Injectable } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { notifications, organizationMembers, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { logger } from "../../common/logger/logger.service";
import { birthdaySubject, birthdayMessage } from "../hr/lifecycle/hr-notification-texts";
import { forEachOrg, type TenantTx } from "../../common/tenant";

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

    await forEachOrg(this.db, "cron-notifications", async (tx, orgId) => {
      const birthdayMembers = await tx
        .select({
          id: users.id,
          name: users.name,
          firstName: users.firstName,
          lastName: users.lastName,
          email: users.email,
        })
        .from(organizationMembers)
        .innerJoin(users, eq(users.id, organizationMembers.userId))
        .where(
          and(
            eq(organizationMembers.orgId, orgId),
            eq(users.isActive, true),
            sql`EXTRACT(MONTH FROM ${users.dateOfBirth}::date) = ${month}`,
            sql`EXTRACT(DAY FROM ${users.dateOfBirth}::date) = ${day}`,
          ),
        );

      for (const birthdayUser of birthdayMembers) {
        const displayName =
          birthdayUser.firstName && birthdayUser.lastName
            ? `${birthdayUser.firstName} ${birthdayUser.lastName}`
            : birthdayUser.name || birthdayUser.email;

        try {
          await this.notifyAllMembers(tx, orgId, {
            type: "INFO",
            title: birthdaySubject(displayName ?? ""),
            message: birthdayMessage(displayName ?? ""),
            metadata: {
              category: "birthday",
              birthdayUserId: birthdayUser.id,
            },
          });
          birthdayCount++;
        } catch (error) {
          logger.error("Failed to create birthday in-app notifications", {
            userId: birthdayUser.id,
            orgId,
            error,
          });
          throw error;
        }
      }
    });

    logger.info("Daily notifications processed", { birthdayCount, leaveCount, anniversaryCount });

    return { birthdayCount, leaveCount, anniversaryCount };
  }

  private async notifyAllMembers(tx: TenantTx, orgId: string, opts: BroadcastInput): Promise<void> {
    const members = await tx
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(eq(organizationMembers.orgId, orgId));

    if (members.length === 0) return;

    await tx.insert(notifications).values(
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
