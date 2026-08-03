import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { auditLogs, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import type { ListInput } from "./dto/audit-log.schemas";

const AUDIT_DISTINCT_TTL_SECONDS = 300;

function auditActionsKey(orgId: string): string {
  return `audit:actions:${orgId}`;
}

function auditTargetTypesKey(orgId: string): string {
  return `audit:target-types:${orgId}`;
}

@Injectable()
export class AuditLogService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

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

  async listActions(orgId: string): Promise<string[]> {
    return this.cache.cached(auditActionsKey(orgId), async () => {
      const rows = await this.db
        .selectDistinct({ action: auditLogs.action })
        .from(auditLogs)
        .where(eq(auditLogs.orgId, orgId))
        .orderBy(auditLogs.action);
      return rows.map((r) => r.action);
    }, AUDIT_DISTINCT_TTL_SECONDS);
  }

  async listTargetTypes(orgId: string): Promise<string[]> {
    return this.cache.cached(auditTargetTypesKey(orgId), async () => {
      const rows = await this.db
        .selectDistinct({ targetType: auditLogs.targetType })
        .from(auditLogs)
        .where(eq(auditLogs.orgId, orgId))
        .orderBy(auditLogs.targetType);
      const result: string[] = [];
      for (const r of rows) {
        if (r.targetType !== null) result.push(r.targetType);
      }
      return result;
    }, AUDIT_DISTINCT_TTL_SECONDS);
  }
}
