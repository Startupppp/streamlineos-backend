import { Inject, Injectable } from "@nestjs/common";
import { and, count, eq, gte, isNotNull, lt, sql } from "drizzle-orm";
import { tasks, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import type { ScopedRead } from "../access/scoped-read";
import type { AnalyticsInput } from "./dto/task.schemas";

type PerRep = {
  assigneeId: string | null;
  name: string;
  total: number;
  completed: number;
  overdue: number;
  completionRate: number;
};

type TaskAnalyticsReport = {
  period: number;
  total: number;
  completed: number;
  overdue: number;
  completionRate: number;
  perRep: PerRep[];
};

const EMPTY_TASK_ANALYTICS: TaskAnalyticsReport = {
  period: 0,
  total: 0,
  completed: 0,
  overdue: 0,
  completionRate: 0,
  perRep: [],
};

@Injectable()
export class TaskAnalyticsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async analytics(
    read: ScopedRead,
    input: AnalyticsInput,
  ): Promise<TaskAnalyticsReport> {
    // `perRep` is a per-person leaderboard of every assignee, which an `own`-scoped member may not read.
    const visible = read.compose(
      {
        tenant: tasks.orgId,
        scope: { columns: { ownerColumn: tasks.assigneeId } },
      },
      (where) => where.sql,
      () => null,
    );
    if (visible === null)
      return { ...EMPTY_TASK_ANALYTICS, period: input.days };
    const days = input.days;
    const now = new Date();
    const periodStart = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

    const [totalRow] = await this.db
      .select({ total: count() })
      .from(tasks)
      .where(and(visible, gte(tasks.createdAt, periodStart)));

    const [completedRow] = await this.db
      .select({ completed: count() })
      .from(tasks)
      .where(
        and(
          visible,
          eq(tasks.status, "completed"),
          gte(tasks.createdAt, periodStart),
        ),
      );

    const [overdueRow] = await this.db
      .select({ overdue: count() })
      .from(tasks)
      .where(
        and(
          visible,
          eq(tasks.status, "pending"),
          lt(tasks.dueDate, now),
          isNotNull(tasks.dueDate),
        ),
      );

    const perRep = await this.db
      .select({
        assigneeId: tasks.assigneeId,
        firstName: users.firstName,
        lastName: users.lastName,
        name: users.name,
        total: count(),
        completed: sql<number>`SUM(CASE WHEN ${tasks.status} = 'completed' THEN 1 ELSE 0 END)`,
        overdue: sql<number>`SUM(CASE WHEN ${tasks.status} = 'pending' AND ${tasks.dueDate} < NOW() THEN 1 ELSE 0 END)`,
      })
      .from(tasks)
      .leftJoin(users, eq(tasks.assigneeId, users.id))
      .where(
        and(
          visible,
          isNotNull(tasks.assigneeId),
          gte(tasks.createdAt, periodStart),
        ),
      )
      .groupBy(tasks.assigneeId, users.firstName, users.lastName, users.name)
      .orderBy(
        sql`SUM(CASE WHEN ${tasks.status} = 'completed' THEN 1 ELSE 0 END) DESC`,
      )
      .limit(20);

    const totalNum = Number(totalRow?.total ?? 0);
    const completedNum = Number(completedRow?.completed ?? 0);
    const overdueNum = Number(overdueRow?.overdue ?? 0);

    return {
      period: days,
      total: totalNum,
      completed: completedNum,
      overdue: overdueNum,
      completionRate:
        totalNum > 0 ? Math.round((completedNum / totalNum) * 100) : 0,
      perRep: perRep.map((r) => ({
        assigneeId: r.assigneeId,
        name:
          r.firstName && r.lastName
            ? `${r.firstName} ${r.lastName}`
            : (r.name ?? "Unknown"),
        total: Number(r.total),
        completed: Number(r.completed),
        overdue: Number(r.overdue),
        completionRate:
          Number(r.total) > 0
            ? Math.round((Number(r.completed) / Number(r.total)) * 100)
            : 0,
      })),
    };
  }
}
