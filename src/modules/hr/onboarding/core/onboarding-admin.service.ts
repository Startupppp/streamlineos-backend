import { Inject, Injectable } from "@nestjs/common";
import { count, eq, sql } from "drizzle-orm";
import { notifications, onboardingTasks, users } from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { EmailService } from "../../../email/email.service";
import { logger } from "../../../../common/logger/logger.service";
import { getOnboardingReminderEmailTemplate } from "../../../email/templates/notifications-misc";

@Injectable()
export class OnboardingAdminService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly email: EmailService,
  ) {}

  async getProgressSummary(orgId: string) {
    const rows = await this.db
      .select({
        userId: onboardingTasks.userId,
        userName: users.name,
        totalTasks: sql<number>`count(*)::int`,
        completedTasks: sql<number>`sum(case when ${onboardingTasks.status} = 'COMPLETED' then 1 else 0 end)::int`,
        lastCompletedAt: sql<string | null>`max(${onboardingTasks.completedAt})`,
      })
      .from(onboardingTasks)
      .leftJoin(users, eq(onboardingTasks.userId, users.id))
      .where(eq(onboardingTasks.orgId, orgId))
      .groupBy(onboardingTasks.userId, users.name);

    return rows.map((r) => ({
      userId: r.userId,
      userName: r.userName ?? r.userId,
      totalTasks: r.totalTasks,
      completedTasks: r.completedTasks ?? 0,
      percentComplete:
        r.totalTasks > 0
          ? Math.round(((r.completedTasks ?? 0) / r.totalTasks) * 100)
          : 0,
      lastCompletedAt: r.lastCompletedAt ?? null,
    }));
  }

  async sendReminders(
    orgId: string,
    _: string,
  ): Promise<{ sent: number; total: number }> {
    const incompleteUsers = await this.db
      .select({
        userId: onboardingTasks.userId,
        userName: users.name,
        userEmail: users.email,
        totalTasks: count(),
        pendingTasks: sql<number>`COUNT(CASE WHEN ${onboardingTasks.status} != 'COMPLETED' THEN 1 END)::int`,
      })
      .from(onboardingTasks)
      .innerJoin(users, eq(onboardingTasks.userId, users.id))
      .where(eq(onboardingTasks.orgId, orgId))
      .groupBy(onboardingTasks.userId, users.name, users.email)
      .having(
        sql`COUNT(CASE WHEN ${onboardingTasks.status} != 'COMPLETED' THEN 1 END) > 0`,
      );

    if (incompleteUsers.length === 0) {
      return { sent: 0, total: 0 };
    }

    let sentCount = 0;

    for (const user of incompleteUsers) {
      await this.db.insert(notifications).values({
        orgId,
        userId: user.userId,
        type: "WARNING",
        title: "Onboarding Reminder",
        message: `You have ${user.pendingTasks} pending onboarding task(s). Please complete them at your earliest convenience.`,
        link: "/hr/onboarding/my-tasks",
      });

      if (user.userEmail) {
        try {
          await this.email.sendEmail({
            to: user.userEmail,
            subject: "Onboarding reminder — pending tasks",
            html: getOnboardingReminderEmailTemplate(
              user.userName ?? "there",
              user.pendingTasks,
              user.totalTasks,
            ),
          });
          sentCount++;
        } catch {
          logger.warn("Failed to send onboarding reminder email", { userId: user.userId });
        }
      }
    }

    return { sent: sentCount, total: incompleteUsers.length };
  }
}
