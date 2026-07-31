import { Inject, Injectable } from "@nestjs/common";
import { and, count, desc, eq, gte, lte } from "drizzle-orm";
import { hrAuditLogs } from "../../../db/schema/hr/core-audit";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import type { ListAuditLogsInput } from "./dto/hr-core.schemas";

@Injectable()
export class HrAuditService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async log(params: {
    orgId: string;
    actorId: string | null;
    entityType: string;
    entityId: string;
    action: string;
    before?: unknown;
    after?: unknown;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<void> {
    await this.db.insert(hrAuditLogs).values({
      orgId: params.orgId,
      actorId: params.actorId ?? null,
      entityType: params.entityType,
      entityId: params.entityId,
      action: params.action,
      before: (params.before ?? null) as Record<string, unknown> | null,
      after: (params.after ?? null) as Record<string, unknown> | null,
      ipAddress: params.ipAddress ?? null,
      userAgent: params.userAgent ?? null,
    });
  }

  async list(orgId: string, input: ListAuditLogsInput) {
    const { page, limit, entityType, entityId, actorId, action, fromDate, toDate } = input;
    const offset = (page - 1) * limit;

    const conditions = [eq(hrAuditLogs.orgId, orgId)];
    if (entityType) conditions.push(eq(hrAuditLogs.entityType, entityType));
    if (entityId) conditions.push(eq(hrAuditLogs.entityId, entityId));
    if (actorId) conditions.push(eq(hrAuditLogs.actorId, actorId));
    if (action) conditions.push(eq(hrAuditLogs.action, action));
    if (fromDate) conditions.push(gte(hrAuditLogs.createdAt, new Date(fromDate)));
    if (toDate) conditions.push(lte(hrAuditLogs.createdAt, new Date(toDate)));

    const where = and(...conditions);

    const [data, totalResult] = await Promise.all([
      this.db
        .select()
        .from(hrAuditLogs)
        .where(where)
        .orderBy(desc(hrAuditLogs.createdAt))
        .limit(limit)
        .offset(offset),
      this.db.select({ total: count() }).from(hrAuditLogs).where(where),
    ]);

    const total = totalResult[0]?.total ?? 0;

    return {
      data,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }
}
