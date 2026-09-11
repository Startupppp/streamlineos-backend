import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, lt, or } from "drizzle-orm";
import { workflows, workflowSchedules } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { CreateScheduleDto, UpdateScheduleDto, ScheduleListQueryDto } from "./dto/workflow.schemas";
import { buildCursorPage, decodeCursor } from "../../common/pagination/cursor";
import { PAGE_SIZE_CAP } from "../../common/pagination/list-query.schema";

@Injectable()
export class WorkflowsSchedulesService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listAllSchedules(orgId: string, query: ScheduleListQueryDto) {
    const { cursor, limit: rawLimit } = query;
    const limit = Math.min(rawLimit, PAGE_SIZE_CAP);
    const position = decodeCursor(cursor);
    const conditions = [eq(workflowSchedules.orgId, orgId)];
    if (position) {
      const cursorDate = new Date(position.sortValue);
      const cursorId = position.id;
      conditions.push(
        or(
          lt(workflowSchedules.createdAt, cursorDate),
          and(eq(workflowSchedules.createdAt, cursorDate), lt(workflowSchedules.id, cursorId)),
        )!,
      );
    }
    const rows = await this.db
      .select()
      .from(workflowSchedules)
      .where(and(...conditions))
      .orderBy(desc(workflowSchedules.createdAt), desc(workflowSchedules.id))
      .limit(limit + 1);
    return buildCursorPage(rows, limit, (row) => ({
      sortValue: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt ?? ""),
      id: row.id,
    }));
  }

  async listSchedules(orgId: string, workflowId: string, query: ScheduleListQueryDto) {
    const workflow = await this.db.query.workflows.findFirst({
      where: and(eq(workflows.id, workflowId), eq(workflows.orgId, orgId)),
      columns: { id: true },
    });
    if (!workflow) throw new NotFoundException("Workflow not found");

    const { cursor, limit: rawLimit } = query;
    const limit = Math.min(rawLimit, PAGE_SIZE_CAP);
    const position = decodeCursor(cursor);
    const conditions = [
      eq(workflowSchedules.workflowId, workflowId),
      eq(workflowSchedules.orgId, orgId),
    ];
    if (position) {
      const cursorDate = new Date(position.sortValue);
      const cursorId = position.id;
      conditions.push(
        or(
          lt(workflowSchedules.createdAt, cursorDate),
          and(eq(workflowSchedules.createdAt, cursorDate), lt(workflowSchedules.id, cursorId)),
        )!,
      );
    }
    const rows = await this.db
      .select()
      .from(workflowSchedules)
      .where(and(...conditions))
      .orderBy(desc(workflowSchedules.createdAt), desc(workflowSchedules.id))
      .limit(limit + 1);
    return buildCursorPage(rows, limit, (row) => ({
      sortValue: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt ?? ""),
      id: row.id,
    }));
  }

  async createSchedule(orgId: string, workflowId: string, dto: CreateScheduleDto) {
    const workflow = await this.db.query.workflows.findFirst({
      where: and(eq(workflows.id, workflowId), eq(workflows.orgId, orgId)),
      columns: { id: true },
    });
    if (!workflow) throw new NotFoundException("Workflow not found");

    const [schedule] = await this.db
      .insert(workflowSchedules)
      .values({ workflowId, orgId, ...dto })
      .returning();

    return schedule;
  }

  async updateSchedule(orgId: string, workflowId: string, scheduleId: string, dto: UpdateScheduleDto) {
    const [updated] = await this.db
      .update(workflowSchedules)
      .set({ ...dto, updatedAt: new Date() })
      .where(
        and(
          eq(workflowSchedules.id, scheduleId),
          eq(workflowSchedules.workflowId, workflowId),
          eq(workflowSchedules.orgId, orgId),
        ),
      )
      .returning();
    if (!updated) throw new NotFoundException("Schedule not found");

    return updated;
  }

  async deleteSchedule(orgId: string, workflowId: string, scheduleId: string) {
    const [deleted] = await this.db
      .delete(workflowSchedules)
      .where(
        and(
          eq(workflowSchedules.id, scheduleId),
          eq(workflowSchedules.workflowId, workflowId),
          eq(workflowSchedules.orgId, orgId),
        ),
      )
      .returning({ id: workflowSchedules.id });
    if (!deleted) throw new NotFoundException("Schedule not found");
  }
}
