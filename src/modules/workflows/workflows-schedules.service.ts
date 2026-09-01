import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { workflows, workflowSchedules } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { CreateScheduleDto, UpdateScheduleDto } from "./dto/workflow.schemas";

@Injectable()
export class WorkflowsSchedulesService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  listAllSchedules(orgId: string) {
    return this.db
      .select()
      .from(workflowSchedules)
      .where(eq(workflowSchedules.orgId, orgId))
      .orderBy(desc(workflowSchedules.createdAt))
      .limit(200);
  }

  async listSchedules(orgId: string, workflowId: string) {
    const workflow = await this.db.query.workflows.findFirst({
      where: and(eq(workflows.id, workflowId), eq(workflows.orgId, orgId)),
      columns: { id: true },
    });
    if (!workflow) throw new NotFoundException("Workflow not found");

    return this.db
      .select()
      .from(workflowSchedules)
      .where(
        and(
          eq(workflowSchedules.workflowId, workflowId),
          eq(workflowSchedules.orgId, orgId),
        ),
      )
      .limit(100);
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
    const existing = await this.db.query.workflowSchedules.findFirst({
      where: and(
        eq(workflowSchedules.id, scheduleId),
        eq(workflowSchedules.workflowId, workflowId),
        eq(workflowSchedules.orgId, orgId),
      ),
      columns: { id: true },
    });
    if (!existing) throw new NotFoundException("Schedule not found");

    const [updated] = await this.db
      .update(workflowSchedules)
      .set({ ...dto, updatedAt: new Date() })
      .where(eq(workflowSchedules.id, scheduleId))
      .returning();

    return updated;
  }

  async deleteSchedule(orgId: string, workflowId: string, scheduleId: string) {
    const existing = await this.db.query.workflowSchedules.findFirst({
      where: and(
        eq(workflowSchedules.id, scheduleId),
        eq(workflowSchedules.workflowId, workflowId),
        eq(workflowSchedules.orgId, orgId),
      ),
      columns: { id: true },
    });
    if (!existing) throw new NotFoundException("Schedule not found");

    await this.db
      .delete(workflowSchedules)
      .where(eq(workflowSchedules.id, scheduleId));
  }
}
