import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, ilike, sql } from "drizzle-orm";
import {
  workflows,
  workflowVersions,
  workflowAuditLogs,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { buildCursorPage, decodeCursor } from "../../common/pagination/cursor";
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
    const { cursor, limit, sort, direction, status, search } = query;

    const conditions: ReturnType<typeof eq>[] = [eq(workflows.orgId, orgId)];
    if (status) conditions.push(eq(workflows.status, status));
    if (search) conditions.push(ilike(workflows.name, `%${search}%`));

    const sortCol = sort === "createdAt" ? workflows.createdAt : workflows.updatedAt;
    const decoded = decodeCursor(cursor);

    if (decoded) {
      const cursorDate = new Date(decoded.sortValue);
      const cursorId = decoded.id;
      const cursorCond =
        direction === "desc"
          ? sql`(${sortCol}, ${workflows.id}::text) < (${sql.param(cursorDate, sortCol)}, ${cursorId})`
          : sql`(${sortCol}, ${workflows.id}::text) > (${sql.param(cursorDate, sortCol)}, ${cursorId})`;
      conditions.push(cursorCond as ReturnType<typeof eq>);
    }

    const orderFn = direction === "asc" ? asc : desc;

    const rows = await this.db
      .select({
        id: workflows.id,
        orgId: workflows.orgId,
        name: workflows.name,
        description: workflows.description,
        status: workflows.status,
        version: workflows.version,
        createdBy: workflows.createdBy,
        createdAt: workflows.createdAt,
        updatedAt: workflows.updatedAt,
      })
      .from(workflows)
      .where(and(...conditions))
      .orderBy(orderFn(sortCol), orderFn(workflows.id))
      .limit(limit + 1);

    return buildCursorPage(rows, limit, (row) => ({
      sortValue: (sort === "createdAt" ? row.createdAt : row.updatedAt).toISOString(),
      id: row.id,
    }));
  }

  async getWorkflow(orgId: string, workflowId: string) {
    const [row] = await this.db
      .select({
        id: workflows.id,
        orgId: workflows.orgId,
        name: workflows.name,
        description: workflows.description,
        status: workflows.status,
        version: workflows.version,
        createdBy: workflows.createdBy,
        createdAt: workflows.createdAt,
        updatedAt: workflows.updatedAt,
        createdByName: users.name,
        createdByEmail: users.email,
      })
      .from(workflows)
      .leftJoin(users, eq(users.id, workflows.createdBy))
      .where(and(eq(workflows.id, workflowId), eq(workflows.orgId, orgId)))
      .limit(1);

    if (!row) throw new NotFoundException("Workflow not found");

    const versions = await this.db
      .select()
      .from(workflowVersions)
      .where(and(eq(workflowVersions.workflowId, workflowId), eq(workflowVersions.orgId, orgId)))
      .orderBy(desc(workflowVersions.version))
      .limit(1);

    return { ...row, versions };
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

    if (dto.expectedVersion !== undefined && dto.expectedVersion !== workflow.version)
      throw new ConflictException(
        "Workflow was modified by another user — refresh to see the latest version before publishing",
      );

    const nextVersion = workflow.version + 1;

    return this.db.transaction(async (tx) => {
      const [version] = await tx
        .insert(workflowVersions)
        .values({
          orgId,
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
        .where(and(eq(workflows.id, workflowId), eq(workflows.orgId, orgId)))
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
