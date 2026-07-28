import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, ilike, count } from "drizzle-orm";
import {
  workflows,
  workflowVersions,
  workflowAuditLogs,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type {
  CreateWorkflowDto,
  UpdateWorkflowDto,
  PublishWorkflowDto,
  WorkflowListQueryDto,
} from "./dto/workflow.schemas";

@Injectable()
export class WorkflowsCrudService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listWorkflows(orgId: string, query: WorkflowListQueryDto) {
    const { page, limit, status, search } = query;
    const offset = (page - 1) * limit;

    const conditions = [eq(workflows.orgId, orgId)];
    if (status) conditions.push(eq(workflows.status, status));
    if (search) conditions.push(ilike(workflows.name, `%${search}%`));

    const where = and(...conditions);

    const [data, [countRow]] = await Promise.all([
      this.db
        .select()
        .from(workflows)
        .where(where)
        .orderBy(desc(workflows.updatedAt))
        .limit(limit)
        .offset(offset),
      this.db.select({ total: count() }).from(workflows).where(where),
    ]);

    return { data, total: countRow?.total ?? 0, page, limit };
  }

  async getWorkflow(orgId: string, workflowId: string) {
    const workflow = await this.db.query.workflows.findFirst({
      where: and(eq(workflows.id, workflowId), eq(workflows.orgId, orgId)),
      with: {
        versions: {
          orderBy: [desc(workflowVersions.version)],
          limit: 1,
        },
      },
    });
    if (!workflow) throw new NotFoundException("Workflow not found");
    return workflow;
  }

  async createWorkflow(
    orgId: string,
    userId: string,
    dto: CreateWorkflowDto,
  ) {
    const [workflow] = await this.db
      .insert(workflows)
      .values({
        orgId,
        name: dto.name,
        description: dto.description,
        createdBy: userId,
      })
      .returning();

    await this.db.insert(workflowAuditLogs).values({
      orgId,
      workflowId: workflow.id,
      actorId: userId,
      event: "created",
      metadata: { name: dto.name },
    });

    return workflow;
  }

  async updateWorkflow(
    orgId: string,
    userId: string,
    workflowId: string,
    dto: UpdateWorkflowDto,
  ) {
    const existing = await this.db.query.workflows.findFirst({
      where: and(eq(workflows.id, workflowId), eq(workflows.orgId, orgId)),
      columns: { id: true },
    });
    if (!existing) throw new NotFoundException("Workflow not found");

    const [updated] = await this.db
      .update(workflows)
      .set({ ...dto, updatedAt: new Date() })
      .where(and(eq(workflows.id, workflowId), eq(workflows.orgId, orgId)))
      .returning();

    await this.db.insert(workflowAuditLogs).values({
      orgId,
      workflowId,
      actorId: userId,
      event: "updated",
      metadata: dto as Record<string, unknown>,
    });

    return updated;
  }

  async deleteWorkflow(orgId: string, userId: string, workflowId: string) {
    const existing = await this.db.query.workflows.findFirst({
      where: and(eq(workflows.id, workflowId), eq(workflows.orgId, orgId)),
      columns: { id: true },
    });
    if (!existing) throw new NotFoundException("Workflow not found");

    await this.db
      .delete(workflows)
      .where(and(eq(workflows.id, workflowId), eq(workflows.orgId, orgId)));

    await this.db.insert(workflowAuditLogs).values({
      orgId,
      workflowId,
      actorId: userId,
      event: "deleted",
    });
  }

  async publishWorkflow(
    orgId: string,
    userId: string,
    workflowId: string,
    dto: PublishWorkflowDto,
  ) {
    const workflow = await this.db.query.workflows.findFirst({
      where: and(eq(workflows.id, workflowId), eq(workflows.orgId, orgId)),
      columns: { id: true, version: true },
    });
    if (!workflow) throw new NotFoundException("Workflow not found");

    const nextVersion = workflow.version + 1;

    return this.db.transaction(async (tx) => {
      const [version] = await tx
        .insert(workflowVersions)
        .values({
          workflowId,
          version: nextVersion,
          definitionJson: dto.definitionJson,
          publishedBy: userId,
          publishedAt: new Date(),
        })
        .returning();

      const [updated] = await tx
        .update(workflows)
        .set({
          version: nextVersion,
          status: "published",
          updatedAt: new Date(),
        })
        .where(eq(workflows.id, workflowId))
        .returning();

      await tx.insert(workflowAuditLogs).values({
        orgId,
        workflowId,
        actorId: userId,
        event: "published",
        metadata: { version: nextVersion },
      });

      return { workflow: updated, version };
    });
  }

  async duplicateWorkflow(orgId: string, userId: string, workflowId: string) {
    const original = await this.db.query.workflows.findFirst({
      where: and(eq(workflows.id, workflowId), eq(workflows.orgId, orgId)),
    });
    if (!original) throw new NotFoundException("Workflow not found");

    const [copy] = await this.db
      .insert(workflows)
      .values({
        orgId,
        name: `${original.name} (Copy)`,
        description: original.description,
        status: "draft",
        version: 1,
        createdBy: userId,
      })
      .returning();

    await this.db.insert(workflowAuditLogs).values({
      orgId,
      workflowId: copy.id,
      actorId: userId,
      event: "duplicated",
      metadata: { sourceId: workflowId },
    });

    return copy;
  }

  async disableWorkflow(orgId: string, userId: string, workflowId: string) {
    const [updated] = await this.db
      .update(workflows)
      .set({ status: "disabled", updatedAt: new Date() })
      .where(and(eq(workflows.id, workflowId), eq(workflows.orgId, orgId)))
      .returning();
    if (!updated) throw new NotFoundException("Workflow not found");
    await this.db.insert(workflowAuditLogs).values({
      orgId,
      workflowId,
      actorId: userId,
      event: "disabled",
    });
    return updated;
  }

  async archiveWorkflow(orgId: string, userId: string, workflowId: string) {
    const [updated] = await this.db
      .update(workflows)
      .set({ status: "archived", updatedAt: new Date() })
      .where(and(eq(workflows.id, workflowId), eq(workflows.orgId, orgId)))
      .returning();
    if (!updated) throw new NotFoundException("Workflow not found");
    await this.db.insert(workflowAuditLogs).values({
      orgId,
      workflowId,
      actorId: userId,
      event: "archived",
    });
    return updated;
  }
}
