import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { tasks } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import type { DataScope } from "../../access/access.types";
import { applyScope } from "../../access/apply-scope";
import type { SnoozeTaskInput } from "./crm-inbox.dto";
import { CrmInboxQueriesService, type InboxResponse, type InboxCounts } from "./crm-inbox-queries.service";

export type { InboxResponse, InboxCounts };

@Injectable()
export class CrmInboxService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly queries: CrmInboxQueriesService,
  ) {}

  getInbox(orgId: string, userId: string, scope: DataScope): Promise<InboxResponse> {
    return this.queries.getInbox(orgId, userId, scope);
  }

  getCounts(orgId: string, userId: string, scope: DataScope): Promise<InboxCounts> {
    return this.queries.getCounts(orgId, userId, scope);
  }

  async snoozeTask(
    orgId: string,
    taskId: number,
    userId: string,
    input: SnoozeTaskInput,
    scope: DataScope,
  ): Promise<void> {
    const scopeFilter = applyScope(scope, orgId, userId, { ownerColumn: tasks.assigneeId });
    const where = and(eq(tasks.id, taskId), eq(tasks.orgId, orgId), scopeFilter);

    const [task] = await this.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(where)
      .limit(1);

    if (!task) throw new NotFoundException("Task not found");

    await this.db
      .update(tasks)
      .set({ snoozedUntil: new Date(input.until), updatedAt: new Date() })
      .where(where);
  }

  async completeTask(
    orgId: string,
    taskId: number,
    userId: string,
    scope: DataScope,
  ): Promise<void> {
    const scopeFilter = applyScope(scope, orgId, userId, { ownerColumn: tasks.assigneeId });
    const where = and(eq(tasks.id, taskId), eq(tasks.orgId, orgId), scopeFilter);

    const [task] = await this.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(where)
      .limit(1);

    if (!task) throw new NotFoundException("Task not found");

    await this.db
      .update(tasks)
      .set({ status: "completed", completedAt: new Date(), updatedAt: new Date() })
      .where(where);
  }
}
