import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gt, gte, ilike, inArray, lte, or, sql } from "drizzle-orm";
import { auditLogs, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { toCsv } from "../inventory/import-export/csv.util";
import { buildCursorPage, decodeCursor } from "../../common/pagination/cursor";
import { keysetBeforeId } from "../../common/pagination/keyset";
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import type { ExportInput, ListInput } from "./dto/audit-log.schemas";

const AUDIT_DISTINCT_TTL_SECONDS = 300;
const EXPORT_ROW_CAP = 10_000;
const EXPORT_PAGE_SIZE = 500;

function auditActionsKey(orgId: string): string {
  return `audit:actions:${orgId}`;
}

function auditTargetTypesKey(orgId: string): string {
  return `audit:target-types:${orgId}`;
}

function escapeLike(value: string): string {
  return value.replaceAll("%", "\\%").replaceAll("_", "\\_");
}

@Injectable()
export class AuditLogService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  async list(orgId: string, filters: ListInput) {
    const { cursor, limit, action, actions, targetType, dateFrom, dateTo, userSearch } = filters;
    const position = decodeCursor(cursor);

    const conditions = [eq(auditLogs.orgId, orgId)];
    if (action) conditions.push(eq(auditLogs.action, action));
    if (actions?.length) conditions.push(inArray(auditLogs.action, actions));
    if (targetType) {
      const match = or(
        eq(auditLogs.targetType, targetType),
        eq(auditLogs.resourceType, targetType),
      );
      if (match) conditions.push(match);
    }
    if (dateFrom) conditions.push(gte(auditLogs.createdAt, new Date(dateFrom)));
    if (dateTo) {
      const end = new Date(dateTo);
      end.setHours(23, 59, 59, 999);
      conditions.push(lte(auditLogs.createdAt, end));
    }
    if (userSearch) {
      const term = `%${escapeLike(userSearch)}%`;
      const nameOrEmail = or(ilike(users.name, term), ilike(users.email, term));
      if (nameOrEmail) conditions.push(nameOrEmail);
    }
    if (position) conditions.push(keysetBeforeId(auditLogs.createdAt, auditLogs.id, position));

    const resolvedTargetType = sql<string | null>`coalesce(${auditLogs.targetType}, ${auditLogs.resourceType})`;
    const resolvedTargetId = sql<string | null>`coalesce(${auditLogs.targetId}, ${auditLogs.resourceId})`;

    const rows = await this.db
      .select({
        id: auditLogs.id,
        action: auditLogs.action,
        userId: auditLogs.userId,
        userName: users.name,
        userEmail: users.email,
        userImage: users.image,
        targetId: resolvedTargetId,
        targetType: resolvedTargetType,
        metadata: auditLogs.metadata,
        ipAddress: auditLogs.ipAddress,
        createdAt: auditLogs.createdAt,
      })
      .from(auditLogs)
      .leftJoin(users, eq(auditLogs.userId, users.id))
      .where(and(...conditions))
      .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
      .limit(limit + 1);

    const page = buildCursorPage(rows, limit, (row) => ({
      sortValue: row.createdAt.toISOString(),
      id: String(row.id),
    }));

    return {
      logs: page.data,
      pagination: page.pagination,
    };
  }

  async *exportCsvChunks(orgId: string, filters: ExportInput): AsyncGenerator<string> {
    const { action, actions, targetType, dateFrom, dateTo, userSearch } = filters;
    const headers = [
      "id",
      "action",
      "userName",
      "userEmail",
      "targetType",
      "targetId",
      "ipAddress",
      "createdAt",
    ];
    yield toCsv(headers, []);

    let afterId = 0;
    let emitted = 0;

    for (;;) {
      if (emitted >= EXPORT_ROW_CAP) return;

      const conditions = [
        eq(auditLogs.orgId, orgId),
        gt(auditLogs.id, afterId),
      ];
      if (action) conditions.push(eq(auditLogs.action, action));
      if (actions?.length) conditions.push(inArray(auditLogs.action, actions));
      if (targetType) {
        const match = or(
          eq(auditLogs.targetType, targetType),
          eq(auditLogs.resourceType, targetType),
        );
        if (match) conditions.push(match);
      }
      if (dateFrom) conditions.push(gte(auditLogs.createdAt, new Date(dateFrom)));
      if (dateTo) {
        const end = new Date(dateTo);
        end.setHours(23, 59, 59, 999);
        conditions.push(lte(auditLogs.createdAt, end));
      }
      if (userSearch) {
        const term = `%${escapeLike(userSearch)}%`;
        const nameOrEmail = or(ilike(users.name, term), ilike(users.email, term));
        if (nameOrEmail) conditions.push(nameOrEmail);
      }

      const remaining = Math.min(EXPORT_PAGE_SIZE, EXPORT_ROW_CAP - emitted);
      /* One page, one transaction. The handler is `@NoTenantTransaction()` because the
       * generator stays open for the whole download; holding the request transaction
       * across every `res.write` would pin a pooled connection to the client's socket. */
      const rows = await runInTenantTransaction(
        this.db,
        (tx) =>
          tx
            .select({
              id: auditLogs.id,
              action: auditLogs.action,
              userName: users.name,
              userEmail: users.email,
              targetType: sql<string | null>`coalesce(${auditLogs.targetType}, ${auditLogs.resourceType})`,
              targetId: sql<string | null>`coalesce(${auditLogs.targetId}, ${auditLogs.resourceId})`,
              ipAddress: auditLogs.ipAddress,
              createdAt: auditLogs.createdAt,
            })
            .from(auditLogs)
            .leftJoin(users, eq(auditLogs.userId, users.id))
            .where(and(...conditions))
            .orderBy(auditLogs.id)
            .limit(remaining),
        { orgId },
      );

      if (rows.length === 0) return;

      const pageCsv = toCsv(
        headers,
        rows.map((r) => ({
          id: r.id,
          action: r.action,
          userName: r.userName ?? "",
          userEmail: r.userEmail ?? "",
          targetType: r.targetType ?? "",
          targetId: r.targetId ?? "",
          ipAddress: r.ipAddress ?? "",
          createdAt: r.createdAt?.toISOString() ?? "",
        })),
      );
      yield `\n${pageCsv.slice(pageCsv.indexOf("\n") + 1)}`;
      emitted += rows.length;
      afterId = rows[rows.length - 1]!.id;
      if (rows.length < remaining) return;
    }
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
      const resolved = sql<string | null>`coalesce(${auditLogs.targetType}, ${auditLogs.resourceType})`;
      const rows = await this.db
        .selectDistinct({ targetType: resolved })
        .from(auditLogs)
        .where(eq(auditLogs.orgId, orgId))
        .orderBy(resolved);
      const result: string[] = [];
      for (const r of rows) {
        if (r.targetType !== null) result.push(r.targetType);
      }
      return result;
    }, AUDIT_DISTINCT_TTL_SECONDS);
  }
}
