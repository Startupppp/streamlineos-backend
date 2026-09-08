import { Inject, Injectable } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { notifications, organizationMembers, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { logger } from "../../common/logger/logger.service";
import { birthdaySubject, birthdayMessage } from "../hr/lifecycle/hr-notification-texts";
import { forEachOrg, type TenantTx } from "../../common/tenant";

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

      if (birthdayMembers.length === 0) return;

      const celebrations = birthdayMembers.map((birthdayUser) => {
        const displayName =
          birthdayUser.firstName && birthdayUser.lastName
            ? `${birthdayUser.firstName} ${birthdayUser.lastName}`
            : birthdayUser.name || birthdayUser.email;
        return {
          title: birthdaySubject(displayName ?? ""),
          message: birthdayMessage(displayName ?? ""),
          metadata: { category: "birthday", birthdayUserId: birthdayUser.id },
        };
      });

      try {
        await this.announceToOrg(tx, orgId, celebrations);
        birthdayCount += celebrations.length;
      } catch (error) {
        logger.error("Failed to create birthday in-app notifications", {
          orgId,
          celebrants: birthdayMembers.map((birthdayUser) => birthdayUser.id),
          error,
        });
        throw error;
      }
    });

    logger.info("Daily notifications processed", { birthdayCount, leaveCount, anniversaryCount });

    return { birthdayCount, leaveCount, anniversaryCount };
  }

  private async announceToOrg(
    tx: TenantTx,
    orgId: string,
    announcements: ReadonlyArray<{
      title: string;
      message: string;
      metadata: Record<string, unknown>;
    }>,
  ): Promise<void> {
    await tx.execute(sql`
      INSERT INTO ${notifications} (org_id, user_id, title, message, metadata)
      SELECT ${orgId}, ${organizationMembers.userId}, c.title, c.message, c.metadata
      FROM ${organizationMembers}
      CROSS JOIN jsonb_to_recordset(${JSON.stringify(announcements)}::jsonb)
        AS c(title text, message text, metadata jsonb)
      WHERE ${eq(organizationMembers.orgId, orgId)}
    `);
  }
}
