import { Inject, Injectable } from "@nestjs/common";
import { and, count, desc, eq } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { timesheetAuditEvents, users } from "../../db/schema";
import type { AuditQuery } from "./dto/audit.schemas";

export interface AuditEventParams {
  orgId: string;
  actorUserId: string;
  entityType: string;
  entityId: string;
  action: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
}

type DbLike = Pick<Db, "insert">;

@Injectable()
export class TimesheetsAuditService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async record(dbOrTx: DbLike, params: AuditEventParams): Promise<void> {
    await dbOrTx.insert(timesheetAuditEvents).values({
      orgId: params.orgId,
      actorUserId: params.actorUserId,
      entityType: params.entityType,
      entityId: params.entityId,
      action: params.action,
      before: (params.before ?? null) as Record<string, unknown> | null,
      after: (params.after ?? null) as Record<string, unknown> | null,
      reason: params.reason ?? null,
    });
  }

  recordWithDb(params: AuditEventParams): Promise<void> {
    return this.record(this.db, params);
  }

  async listAuditEvents(orgId: string, query: AuditQuery) {
    const limit = Math.min(query.limit, 100);
    const offset = (query.page - 1) * limit;

    const conditions = [eq(timesheetAuditEvents.orgId, orgId)];
    if (query.entityType) conditions.push(eq(timesheetAuditEvents.entityType, query.entityType));
    if (query.entityId) conditions.push(eq(timesheetAuditEvents.entityId, query.entityId));
    if (query.action) conditions.push(eq(timesheetAuditEvents.action, query.action));

    const [totalResult, rows] = await Promise.all([
      this.db
        .select({ total: count() })
        .from(timesheetAuditEvents)
        .where(and(...conditions)),
      this.db
        .select({
          id: timesheetAuditEvents.id,
          actorUserId: timesheetAuditEvents.actorUserId,
          actorName: users.name,
          entityType: timesheetAuditEvents.entityType,
          entityId: timesheetAuditEvents.entityId,
          action: timesheetAuditEvents.action,
          before: timesheetAuditEvents.before,
          after: timesheetAuditEvents.after,
          reason: timesheetAuditEvents.reason,
          createdAt: timesheetAuditEvents.createdAt,
        })
        .from(timesheetAuditEvents)
        .leftJoin(users, eq(timesheetAuditEvents.actorUserId, users.id))
        .where(and(...conditions))
        .orderBy(desc(timesheetAuditEvents.createdAt))
        .limit(limit)
        .offset(offset),
    ]);

    return {
      data: rows,
      total: totalResult[0]?.total ?? 0,
    };
  }
}
