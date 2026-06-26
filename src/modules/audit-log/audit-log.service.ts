import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { auditLogs, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { ListInput } from "./dto/audit-log.schemas";

@Injectable()
export class AuditLogService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async list(orgId: string, filters: ListInput) {
    const { page, pageSize, action, targetType, dateFrom, dateTo } = filters;
    const offset = (page - 1) * pageSize;

    const conditions = [eq(auditLogs.orgId, orgId)];
    if (action) conditions.push(eq(auditLogs.action, action));
    if (targetType) conditions.push(eq(auditLogs.targetType, targetType));
    if (dateFrom) conditions.push(gte(auditLogs.createdAt, new Date(dateFrom)));
    if (dateTo) {
      const end = new Date(dateTo);
      end.setHours(23, 59, 59, 999);
      conditions.push(lte(auditLogs.createdAt, end));
    }

    const where = and(...conditions);

    const [rows, [{ count }]] = await Promise.all([
      this.db
        .select({
          id: auditLogs.id,
          action: auditLogs.action,
          userId: auditLogs.userId,
          userName: users.name,
          userEmail: users.email,
          userImage: users.image,
          targetId: auditLogs.targetId,
          targetType: auditLogs.targetType,
          metadata: auditLogs.metadata,
          ipAddress: auditLogs.ipAddress,
          createdAt: auditLogs.createdAt,
        })
        .from(auditLogs)
        .leftJoin(users, eq(auditLogs.userId, users.id))
        .where(where)
        .orderBy(desc(auditLogs.createdAt))
        .limit(pageSize)
        .offset(offset),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(auditLogs)
        .where(where),
    ]);

    return {
      logs: rows,
      total: count,
      page,
      totalPages: Math.ceil(count / pageSize),
    };
  }

  async listActions(orgId: string) {
    const rows = await this.db
      .selectDistinct({ action: auditLogs.action })
      .from(auditLogs)
      .where(eq(auditLogs.orgId, orgId))
      .orderBy(auditLogs.action);

    return rows.map((r) => r.action);
  }

  async listTargetTypes(orgId: string) {
    const rows = await this.db
      .selectDistinct({ targetType: auditLogs.targetType })
      .from(auditLogs)
      .where(eq(auditLogs.orgId, orgId))
      .orderBy(auditLogs.targetType);

    return rows
      .filter((r) => r.targetType !== null)
      .map((r) => r.targetType as string);
  }
}
