import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, count, desc, eq, isNull } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import {
  hrAccommodationRequests,
  hrAccommodationTasks,
} from "../../../db/schema/hr/enterprise-ops";
import { HrAuditService } from "../../hr-core/hr-audit.service";
import type {
  CreateAccommodationInput,
  UpdateAccommodationInput,
  ApproveAccommodationInput,
  ListAccommodationsInput,
  CreateAccommodationTaskInput,
  UpdateAccommodationTaskInput,
} from "../dto/accommodations.schemas";

const SENSITIVE_FIELDS = ["confidential_medical_note", "confidentialMedicalNote"] as const;

function maskSensitive<T extends { confidentialMedicalNote?: string | null }>(
  row: T,
  hasSensitive: boolean,
): T {
  if (hasSensitive) return row;
  return { ...row, confidentialMedicalNote: null };
}

@Injectable()
export class AccommodationsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: HrAuditService,
  ) {}

  async list(orgId: string, input: ListAccommodationsInput, hasSensitive: boolean) {
    const { page, limit, userId, status, type } = input;
    const offset = (page - 1) * limit;

    const conditions = [eq(hrAccommodationRequests.orgId, orgId), isNull(hrAccommodationRequests.deletedAt)];
    if (userId) conditions.push(eq(hrAccommodationRequests.userId, userId));
    if (status) conditions.push(eq(hrAccommodationRequests.status, status));
    if (type) conditions.push(eq(hrAccommodationRequests.type, type));

    const where = and(...conditions);

    const [rows, totalResult] = await Promise.all([
      this.db
        .select()
        .from(hrAccommodationRequests)
        .where(where)
        .orderBy(desc(hrAccommodationRequests.createdAt))
        .limit(limit)
        .offset(offset),
      this.db.select({ total: count() }).from(hrAccommodationRequests).where(where),
    ]);

    const total = totalResult[0]?.total ?? 0;

    return {
      data: rows.map((r) => maskSensitive(r, hasSensitive)),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async getById(orgId: string, id: string, hasSensitive: boolean) {
    const row = await this.db.query.hrAccommodationRequests.findFirst({
      where: and(
        eq(hrAccommodationRequests.orgId, orgId),
        eq(hrAccommodationRequests.id, id),
        isNull(hrAccommodationRequests.deletedAt),
      ),
    });
    if (!row) throw new NotFoundException("Accommodation request not found");
    return maskSensitive(row, hasSensitive);
  }

  async create(
    orgId: string,
    actorId: string,
    input: CreateAccommodationInput,
    ip?: string,
    ua?: string,
  ) {
    const [row] = await this.db
      .insert(hrAccommodationRequests)
      .values({ orgId, ...input, status: "requested" })
      .returning();

    if (row) {
      await this.audit.log({
        orgId,
        actorId,
        entityType: "accommodation_request",
        entityId: row.id,
        action: "create",
        after: { type: row.type, userId: row.userId },
        ipAddress: ip,
        userAgent: ua,
      });
    }

    return row;
  }

  async update(
    orgId: string,
    id: string,
    actorId: string,
    input: UpdateAccommodationInput,
    ip?: string,
    ua?: string,
  ) {
    const existing = await this.getById(orgId, id, true);

    const [row] = await this.db
      .update(hrAccommodationRequests)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(hrAccommodationRequests.orgId, orgId), eq(hrAccommodationRequests.id, id)))
      .returning();

    await this.audit.log({
      orgId,
      actorId,
      entityType: "accommodation_request",
      entityId: id,
      action: "update",
      before: { status: existing.status },
      after: { status: row?.status, changes: Object.keys(input) },
      ipAddress: ip,
      userAgent: ua,
    });

    return row;
  }

  async approve(
    orgId: string,
    id: string,
    actorId: string,
    input: ApproveAccommodationInput,
    ip?: string,
    ua?: string,
  ) {
    const existing = await this.getById(orgId, id, true);
    if (!existing) throw new NotFoundException("Not found");

    const now = new Date();

    const [row] = await this.db
      .update(hrAccommodationRequests)
      .set({
        status: "approved",
        reviewedBy: actorId,
        reviewDate: now.toISOString().slice(0, 10),
        note: input.note ?? null,
        updatedAt: now,
      })
      .where(and(eq(hrAccommodationRequests.orgId, orgId), eq(hrAccommodationRequests.id, id)))
      .returning();

    if (input.tasks && input.tasks.length > 0) {
      await this.db.insert(hrAccommodationTasks).values(
        input.tasks.map((t) => ({
          orgId,
          requestId: id,
          title: t.title,
          assigneeUserId: t.assigneeUserId ?? null,
          dueDate: t.dueDate ?? null,
          status: "pending" as const,
        })),
      );
    }

    await this.audit.log({
      orgId,
      actorId,
      entityType: "accommodation_request",
      entityId: id,
      action: "approve",
      before: { status: existing.status },
      after: { status: "approved", tasksCreated: input.tasks?.length ?? 0 },
      ipAddress: ip,
      userAgent: ua,
    });

    return row;
  }

  async softDelete(orgId: string, id: string, actorId: string, ip?: string, ua?: string) {
    const existing = await this.getById(orgId, id, false);
    if (!existing) throw new NotFoundException("Not found");

    await this.db
      .update(hrAccommodationRequests)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(hrAccommodationRequests.orgId, orgId), eq(hrAccommodationRequests.id, id)));

    await this.audit.log({
      orgId,
      actorId,
      entityType: "accommodation_request",
      entityId: id,
      action: "delete",
      ipAddress: ip,
      userAgent: ua,
    });
  }

  async listTasks(orgId: string, requestId: string) {
    return this.db
      .select()
      .from(hrAccommodationTasks)
      .where(and(eq(hrAccommodationTasks.orgId, orgId), eq(hrAccommodationTasks.requestId, requestId)))
      .orderBy(hrAccommodationTasks.createdAt);
  }

  async createTask(orgId: string, requestId: string, input: CreateAccommodationTaskInput) {
    const [row] = await this.db
      .insert(hrAccommodationTasks)
      .values({ orgId, requestId, ...input, status: input.status ?? "pending" })
      .returning();
    return row;
  }

  async updateTask(
    orgId: string,
    requestId: string,
    taskId: string,
    input: UpdateAccommodationTaskInput,
  ) {
    const [row] = await this.db
      .update(hrAccommodationTasks)
      .set({ ...input, updatedAt: new Date() })
      .where(
        and(
          eq(hrAccommodationTasks.orgId, orgId),
          eq(hrAccommodationTasks.requestId, requestId),
          eq(hrAccommodationTasks.id, taskId),
        ),
      )
      .returning();
    if (!row) throw new NotFoundException("Task not found");
    return row;
  }

  async deleteTask(orgId: string, requestId: string, taskId: string) {
    const result = await this.db
      .delete(hrAccommodationTasks)
      .where(
        and(
          eq(hrAccommodationTasks.orgId, orgId),
          eq(hrAccommodationTasks.requestId, requestId),
          eq(hrAccommodationTasks.id, taskId),
        ),
      )
      .returning({ id: hrAccommodationTasks.id });
    if (!result.length) throw new NotFoundException("Task not found");
  }
}
