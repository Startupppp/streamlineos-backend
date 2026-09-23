import { Inject, Injectable, OnModuleInit } from "@nestjs/common";
import { and, count, desc, eq, isNull } from "drizzle-orm";
import { activities } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { AttentionAdapterRegistry } from "../attention/attention-adapter.registry";
import type {
  InboxSourcePosition,
  ModuleTaskInboxItem,
} from "../notifications/dto/unified-inbox.schemas";

@Injectable()
export class CrmAttentionAdapter implements OnModuleInit {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly registry: AttentionAdapterRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      module: "crm",
      kindLabel: "crm_task",
      permission: "crm:activities:view",
      supportsAfterCursor: false,
      fetch: (orgId, userId, _membershipId, limit, _cursor) =>
        this.fetchTasks(orgId, userId, limit),
      countPending: (orgId, userId, _membershipId) =>
        this.countTasks(orgId, userId),
    });
  }

  private async fetchTasks(
    orgId: string,
    userId: string,
    limit: number,
  ): Promise<ModuleTaskInboxItem[]> {
    const rows = await this.db
      .select({
        activityId: activities.activityId,
        subject: activities.subject,
        body: activities.body,
        dueAt: activities.dueAt,
        occurredAt: activities.occurredAt,
      })
      .from(activities)
      .where(
        and(
          eq(activities.organizationId, orgId),
          eq(activities.assigneeUserId, userId),
          eq(activities.kind, "task"),
          isNull(activities.completedAt),
          isNull(activities.deletedAt),
        ),
      )
      .orderBy(desc(activities.occurredAt))
      .limit(limit);

    return rows.map(
      (row): ModuleTaskInboxItem => ({
        kind: "module_task",
        id: row.activityId,
        taskKind: "crm_task",
        status: "open",
        priority: "MEDIUM",
        dueAt: row.dueAt ? row.dueAt.toISOString() : null,
        body: row.subject ?? row.body ?? "",
        sourceModule: "crm",
        actor: null,
        subject: row.subject ?? "CRM Task",
        timestamp: row.occurredAt.toISOString(),
        isRead: false,
        deepLink: "/crm/activities",
        dedupKey: `task:crm:${row.activityId}`,
      }),
    );
  }

  private async countTasks(orgId: string, userId: string): Promise<number> {
    const [result] = await this.db
      .select({ n: count() })
      .from(activities)
      .where(
        and(
          eq(activities.organizationId, orgId),
          eq(activities.assigneeUserId, userId),
          eq(activities.kind, "task"),
          isNull(activities.completedAt),
          isNull(activities.deletedAt),
        ),
      );
    return result?.n ?? 0;
  }
}
