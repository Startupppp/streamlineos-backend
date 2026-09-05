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

    await this.db.transaction(async (tx) => {
      await tx
        .update(workflowAuditLogs)
        .set({ workflowId: null })
        .where(
          and(
            eq(workflowAuditLogs.workflowId, workflowId),
            eq(workflowAuditLogs.orgId, orgId),
          ),
        );
      await tx
        .delete(workflows)
        .where(and(eq(workflows.id, workflowId), eq(workflows.orgId, orgId)));
      await tx.insert(workflowAuditLogs).values({
        orgId,
        actorId: userId,
        event: "deleted",
        metadata: { deletedWorkflowId: workflowId },
      });
    });
  }

  async publishWorkflow(
    orgId: string,
    userId: string,
    workflowId: string,
    dto: PublishWorkflowDto,
  ) {
    return this.db.transaction(async (tx) => {
      /**
       * Read and compare-and-set inside ONE transaction.
       *
       * The read used to sit outside `db.transaction`, so the version it
       * compared was already stale by the time the write ran, and the write
       * matched on id alone. `workflow_versions` has no unique index on
       * (org_id, workflow_id, version) either — only the pkey, uniq(org_id, id)
       * and a plain btree on (workflow_id, version) — so two editors publishing
       * in the same second both read version 3, both inserted a version-4 row
       * with different definitions, and both succeeded. Whichever
       * `workflows.version` update landed second decided which definition was
       * live and the other publish was lost with a 200.
       *
       * The guard is now the UPDATE's own predicate: `version = expected`.
       * Under READ COMMITTED the second transaction blocks on the row lock, then
       * re-evaluates the predicate against the committed row and matches nothing,
       * so it returns zero rows and we abort. That is the pattern
       * `worker-engagements.service.ts:383` already uses.
       *
       * `expectedVersion` stays OPTIONAL in the DTO: making it required would be
       * a breaking contract change, and — more to the point — it would leave the
       * lost update in place for every caller that omits it, which today is the
       * only caller there is. When it is absent we compare against the version we
       * just read in this transaction, which still serialises two concurrent
       * publishes. When it is supplied it additionally rejects a stale editor
       * that loaded the workflow before someone else published.
       */
      const workflow = await tx.query.workflows.findFirst({
        where: and(eq(workflows.id, workflowId), eq(workflows.orgId, orgId)),
        columns: { id: true, version: true },
      });
      if (!workflow) throw new NotFoundException("Workflow not found");

      const expectedVersion = dto.expectedVersion ?? workflow.version;
      const nextVersion = expectedVersion + 1;

      const [updated] = await tx
        .update(workflows)
        .set({
          version: nextVersion,
          status: "published",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(workflows.id, workflowId),
            eq(workflows.orgId, orgId),
            eq(workflows.version, expectedVersion),
          ),
        )
        .returning();

      if (!updated)
        throw new ConflictException(
          "Workflow was modified by another user — refresh to see the latest version before publishing",
        );

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
