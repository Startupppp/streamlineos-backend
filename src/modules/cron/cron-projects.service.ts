import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, isNotNull, isNull, lte } from "drizzle-orm";
import { projectStatuses, tickets, ticketWatchers } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { logger } from "../../common/logger/logger.service";
import { computeNextRunAt } from "../build/core";
import { bulkUpdateFromValues, type BulkUpdateRow } from "../../common/db/bulk-update";
import { forEachOrg, type TenantTx } from "../../common/tenant";
import { BuildTicketCreationService } from "../build/core/tickets";

const BATCH_SIZE = 50;

type TemplateRow = {
  id: number;
  orgId: string;
  projectId: number | null;
  title: string;
  description: string | null;
  type: (typeof tickets.$inferInsert)["type"];
  priority: (typeof tickets.$inferInsert)["priority"];
  points: number | null;
  assigneeMembershipId: number | null;
  recurrenceRule: NonNullable<(typeof tickets.$inferSelect)["recurrenceRule"]> | null;
  recurrenceNextRunAt: Date | null;
};

type RunnableTemplate = TemplateRow & {
  projectId: number;
  recurrenceRule: NonNullable<TemplateRow["recurrenceRule"]>;
  recurrenceNextRunAt: Date;
};

@Injectable()
export class CronProjectsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly ticketCreation: BuildTicketCreationService,
  ) {}

  async spawnDueRecurringTickets(): Promise<{ spawned: number; advanced: number }> {
    const now = new Date();
    let spawned = 0;
    let advanced = 0;

    await forEachOrg(this.db, "spawn-recurring-tickets", async (tx, orgId) => {
      const dueTemplates: TemplateRow[] = await tx
        .select({
          id: tickets.id,
          orgId: tickets.orgId,
          projectId: tickets.projectId,
          title: tickets.title,
          description: tickets.description,
          type: tickets.type,
          priority: tickets.priority,
          points: tickets.points,
          assigneeMembershipId: tickets.assigneeMembershipId,
          recurrenceRule: tickets.recurrenceRule,
          recurrenceNextRunAt: tickets.recurrenceNextRunAt,
        })
        .from(tickets)
        .where(
          and(
            eq(tickets.orgId, orgId),
            eq(tickets.isRecurring, true),
            isNull(tickets.deletedAt),
            isNotNull(tickets.recurrenceNextRunAt),
            lte(tickets.recurrenceNextRunAt, now),
            isNotNull(tickets.projectId),
          ),
        )
        .limit(BATCH_SIZE);

      const runnable = dueTemplates.filter(
        (template): template is RunnableTemplate =>
          template.projectId !== null &&
          template.recurrenceRule !== null &&
          template.recurrenceNextRunAt !== null,
      );
      if (runnable.length === 0) return;

      const finished: number[] = [];
      const due: RunnableTemplate[] = [];
      for (const template of runnable) {
        const endDate = template.recurrenceRule.endDate
          ? new Date(template.recurrenceRule.endDate)
          : null;
        if (endDate && now > endDate) finished.push(template.id);
        else due.push(template);
      }

      if (finished.length > 0) {
        await tx
          .update(tickets)
          .set({ isRecurring: false, recurrenceNextRunAt: null })
          .where(and(eq(tickets.orgId, orgId), inArray(tickets.id, finished)));
        advanced += finished.length;
      }

      if (due.length === 0) return;

      const spawnedNow = await this.spawnBatch(tx, orgId, due);
      spawned += spawnedNow;
      advanced += spawnedNow;
    });

    return { spawned, advanced };
  }

  private async spawnBatch(
    tx: TenantTx,
    orgId: string,
    due: readonly RunnableTemplate[],
  ): Promise<number> {
    const projectIds = [...new Set(due.map((template) => template.projectId))];

    const statusRows = await tx
      .selectDistinctOn([projectStatuses.projectId], {
        projectId: projectStatuses.projectId,
        name: projectStatuses.name,
      })
      .from(projectStatuses)
      .where(and(eq(projectStatuses.orgId, orgId), inArray(projectStatuses.projectId, projectIds)))
      .orderBy(projectStatuses.projectId, projectStatuses.order)
      .limit(projectIds.length);

    const firstStatusByProject = new Map<number, string>();
    for (const row of statusRows)
      if (!firstStatusByProject.has(row.projectId))
        firstStatusByProject.set(row.projectId, row.name);

    const byProject = new Map<number, RunnableTemplate[]>();
    for (const template of due) {
      const list = byProject.get(template.projectId) ?? [];
      list.push(template);
      byProject.set(template.projectId, list);
    }

    const advances: BulkUpdateRow[] = due.map((template) => ({
      key: template.id,
      values: [
        computeNextRunAt(template.recurrenceRule, template.recurrenceNextRunAt).toISOString(),
      ],
    }));

    try {
      await tx.transaction(async (innerTx) => {
        for (const [projectId, templates] of [...byProject].sort(([a], [b]) => a - b)) {
          const created = await this.ticketCreation.createInTransaction(innerTx, {
            orgId,
            projectId,
            actor: { userId: null, membershipId: null, systemActor: "recurring-spawn" },
            drafts: templates.map((template) => ({
              title: template.title,
              description: template.description ?? undefined,
              type: template.type,
              priority: template.priority,
              points: template.points ?? undefined,
              assigneeMembershipId: template.assigneeMembershipId ?? undefined,
              status: firstStatusByProject.get(template.projectId) ?? "TODO",
              recurrenceParentId: template.id,
              isRecurring: false,
            })),
          });

          const watchers: (typeof ticketWatchers.$inferInsert)[] = [];
          for (const child of created.tickets)
            if (child.assigneeMembershipId !== null)
              watchers.push({ orgId, ticketId: child.id, membershipId: child.assigneeMembershipId });
          if (watchers.length > 0)
            await innerTx.insert(ticketWatchers).values(watchers).onConflictDoNothing();
        }

        await bulkUpdateFromValues(innerTx, {
          table: tickets,
          orgId,
          key: { column: "id", type: "integer" },
          columns: [{ column: "recurrence_next_run_at", type: "timestamp with time zone" }],
          rows: advances,
        });
      });
    } catch (error) {
      logger.error("Failed to spawn recurring tickets", {
        orgId,
        templateIds: due.map((template) => template.id),
        error,
      });
      return 0;
    }

    return due.length;
  }
}
