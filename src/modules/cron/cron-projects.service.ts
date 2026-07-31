import { Inject, Injectable } from "@nestjs/common";
import { and, eq, isNotNull, lte, sql } from "drizzle-orm";
import { projectStatuses, tickets, ticketActivityLog, ticketWatchers } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { logger } from "../../common/logger/logger.service";
import { computeNextRunAt } from "../build/core/projects-recurrence.util";

const BATCH_SIZE = 50;

@Injectable()
export class CronProjectsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async spawnDueRecurringTickets(): Promise<{ spawned: number; advanced: number }> {
    const now = new Date();

    const dueTemplates = await this.db
      .select({
        id: tickets.id,
        orgId: tickets.orgId,
        projectId: tickets.projectId,
        title: tickets.title,
        description: tickets.description,
        type: tickets.type,
        priority: tickets.priority,
        points: tickets.points,
        assigneeId: tickets.assigneeId,
        recurrenceRule: tickets.recurrenceRule,
        recurrenceNextRunAt: tickets.recurrenceNextRunAt,
      })
      .from(tickets)
      .where(
        and(
          eq(tickets.isRecurring, true),
          isNotNull(tickets.recurrenceNextRunAt),
          lte(tickets.recurrenceNextRunAt, now),
          isNotNull(tickets.projectId),
        ),
      )
      .limit(BATCH_SIZE);

    let spawned = 0;
    let advanced = 0;

    for (const template of dueTemplates) {
      if (!template.projectId || !template.recurrenceRule || !template.recurrenceNextRunAt) continue;

      const rule = template.recurrenceRule;
      const endDate = rule.endDate ? new Date(rule.endDate) : null;
      if (endDate && now > endDate) {
        await this.db
          .update(tickets)
          .set({ isRecurring: false, recurrenceNextRunAt: null })
          .where(eq(tickets.id, template.id));
        advanced++;
        continue;
      }

      try {
        await this.db.transaction(async (tx) => {
          const [maxRow] = await tx
            .select({ maxNum: sql<number>`COALESCE(MAX(${tickets.ticketNumber}), 0)` })
            .from(tickets)
            .where(and(eq(tickets.projectId, template.projectId!), eq(tickets.orgId, template.orgId)));

          const nextNum = (maxRow?.maxNum ?? 0) + 1;

          const [firstStatus] = await tx
            .select({ name: projectStatuses.name })
            .from(projectStatuses)
            .where(
              and(
                eq(projectStatuses.orgId, template.orgId),
                eq(projectStatuses.projectId, template.projectId!),
              ),
            )
            .orderBy(projectStatuses.order)
            .limit(1);

          const initialStatus = firstStatus?.name ?? "TODO";

          const [child] = await tx
            .insert(tickets)
            .values({
              orgId: template.orgId,
              projectId: template.projectId,
              ticketNumber: nextNum,
              title: template.title,
              description: template.description ?? undefined,
              type: template.type,
              priority: template.priority,
              points: template.points ?? undefined,
              assigneeId: template.assigneeId ?? undefined,
              status: initialStatus,
              recurrenceParentId: template.id,
              isRecurring: false,
            })
            .returning({ id: tickets.id });

          if (template.assigneeId) {
            await tx
              .insert(ticketWatchers)
              .values({ orgId: template.orgId, ticketId: child.id, userId: template.assigneeId })
              .onConflictDoNothing();
          }

          await tx.insert(ticketActivityLog).values({
            orgId: template.orgId,
            ticketId: child.id,
            userId: template.assigneeId ?? undefined,
            action: "created",
          });

          const nextRunAt = computeNextRunAt(rule, template.recurrenceNextRunAt!);
          await tx
            .update(tickets)
            .set({ recurrenceNextRunAt: nextRunAt })
            .where(eq(tickets.id, template.id));
        });

        spawned++;
        advanced++;
      } catch (error) {
        logger.error("Failed to spawn recurring ticket", { templateId: template.id, error });
      }
    }

    return { spawned, advanced };
  }
}
