import { Inject, Injectable } from "@nestjs/common";
import { and, asc, count, eq, gt, sql } from "drizzle-orm";
import { onboardingTasks, users } from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { EmailOutboxService } from "../../../email/email-outbox.service";
import { NotificationDispatchService } from "../../../notifications/notification-dispatch.service";
import { getOnboardingReminderEmailTemplate } from "../../../email/templates/notifications-misc";

const ONBOARDING_REMINDER_BATCH_SIZE = 100;

interface OnboardingReminderRecipient {
  userId: string;
  userName: string | null;
  userEmail: string | null;
  totalTasks: number;
  pendingTasks: number;
}

@Injectable()
export class OnboardingAdminService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly emailOutbox: EmailOutboxService,
    private readonly dispatch: NotificationDispatchService,
  ) {}

  async getProgressSummary(organizationId: string) {
    const progressRows = await this.db
      .select({
        userId: onboardingTasks.userId,
        userName: users.name,
        totalTasks: sql<number>`count(*)::int`,
        completedTasks: sql<number>`sum(case when ${onboardingTasks.status} = 'COMPLETED' then 1 else 0 end)::int`,
        lastCompletedAt: sql<string | null>`max(${onboardingTasks.completedAt})`,
      })
      .from(onboardingTasks)
      .leftJoin(users, eq(onboardingTasks.userId, users.id))
      .where(eq(onboardingTasks.orgId, organizationId))
      .groupBy(onboardingTasks.userId, users.name);

    return progressRows.map((progressRow) => ({
      userId: progressRow.userId,
      userName: progressRow.userName ?? progressRow.userId,
      totalTasks: progressRow.totalTasks,
      completedTasks: progressRow.completedTasks ?? 0,
      percentComplete:
        progressRow.totalTasks > 0
          ? Math.round(
              ((progressRow.completedTasks ?? 0) / progressRow.totalTasks) *
                100,
            )
          : 0,
      lastCompletedAt: progressRow.lastCompletedAt ?? null,
    }));
  }

  async sendReminders(
    organizationId: string,
  ): Promise<{ sent: number; total: number }> {
    let afterUserId: string | undefined;
    let queuedEmailCount = 0;
    let reminderRecipientCount = 0;

    while (true) {
      const reminderPage = await this.listReminderRecipients(
        organizationId,
        afterUserId,
      );
      const reminderRecipients = reminderPage.slice(
        0,
        ONBOARDING_REMINDER_BATCH_SIZE,
      );

      if (reminderRecipients.length === 0) break;

      for (const recipient of reminderRecipients) {
        await this.dispatch.emit({
          eventKey: "hr.onboarding.task_reminder",
          orgId: organizationId,
          targetUserIds: [recipient.userId],
          entityType: "onboarding",
          entityId: recipient.userId,
          title: "Onboarding Reminder",
          message: `You have ${recipient.pendingTasks} pending onboarding task(s). Please complete them at your earliest convenience.`,
          link: "/hr/onboarding/my-tasks",
          variables: {
            pendingTasks: recipient.pendingTasks,
            totalTasks: recipient.totalTasks,
          },
        });
      }

      queuedEmailCount += await this.emailOutbox.enqueueForDelivery(
        reminderRecipients.flatMap((recipient) =>
          recipient.userEmail
            ? [
                {
                  to: recipient.userEmail,
                  subject: "Onboarding reminder — pending tasks",
                  html: getOnboardingReminderEmailTemplate(
                    recipient.userName ?? "there",
                    recipient.pendingTasks,
                    recipient.totalTasks,
                  ),
                  organizationId,
                  recipientUserId: recipient.userId,
                },
              ]
            : [],
        ),
      );
      reminderRecipientCount += reminderRecipients.length;

      if (reminderPage.length <= ONBOARDING_REMINDER_BATCH_SIZE) break;
      afterUserId = reminderRecipients[reminderRecipients.length - 1]?.userId;
    }

    return { sent: queuedEmailCount, total: reminderRecipientCount };
  }

  private listReminderRecipients(
    organizationId: string,
    afterUserId?: string,
  ): Promise<OnboardingReminderRecipient[]> {
    return this.db
      .select({
        userId: onboardingTasks.userId,
        userName: users.name,
        userEmail: users.email,
        totalTasks: count(),
        pendingTasks: sql<number>`COUNT(CASE WHEN ${onboardingTasks.status} != 'COMPLETED' THEN 1 END)::int`,
      })
      .from(onboardingTasks)
      .innerJoin(users, eq(onboardingTasks.userId, users.id))
      .where(
        afterUserId
          ? and(
              eq(onboardingTasks.orgId, organizationId),
              gt(onboardingTasks.userId, afterUserId),
            )
          : eq(onboardingTasks.orgId, organizationId),
      )
      .groupBy(onboardingTasks.userId, users.name, users.email)
      .having(
        sql`COUNT(CASE WHEN ${onboardingTasks.status} != 'COMPLETED' THEN 1 END) > 0`,
      )
      .orderBy(asc(onboardingTasks.userId))
      .limit(ONBOARDING_REMINDER_BATCH_SIZE + 1);
  }
}
