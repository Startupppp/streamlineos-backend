import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import { tasks } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import type { ScopedRead } from "../../access/scoped-read";
import type { SnoozeTaskInput } from "./crm-inbox.dto";
import { CrmInboxQueriesService } from "./crm-inbox-queries.service";
import type { InboxResponse, InboxCounts } from "./crm-inbox-queries.service";

export type { InboxResponse, InboxCounts } from "./crm-inbox-queries.service";

@Injectable()
export class CrmInboxService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly queries: CrmInboxQueriesService,
  ) {}

  getInbox(read: ScopedRead): Promise<InboxResponse> {
    return this.queries.getInbox(read);
  }

  getCounts(read: ScopedRead): Promise<InboxCounts> {
    return this.queries.getCounts(read);
  }

  async snoozeTask(
    read: ScopedRead,
    taskId: number,
    input: SnoozeTaskInput,
  ): Promise<void> {
    const where = read.compose(
      { tenant: tasks.orgId, scope: { columns: { ownerColumn: tasks.assigneeId } }, and: [eq(tasks.id, taskId)] },
      ({ sql: w }) => w,
      () => sql`false`,
    );

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
    read: ScopedRead,
    taskId: number,
  ): Promise<void> {
    const where = read.compose(
      { tenant: tasks.orgId, scope: { columns: { ownerColumn: tasks.assigneeId } }, and: [eq(tasks.id, taskId)] },
      ({ sql: w }) => w,
      () => sql`false`,
    );

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
