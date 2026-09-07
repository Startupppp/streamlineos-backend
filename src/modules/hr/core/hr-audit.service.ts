import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gte, lt, lte, or } from "drizzle-orm";
import { hrAuditLogs } from "../../../db/schema/hr/core-audit";
import { organizationMembers } from "../../../db/schema/common/auth";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import type { ListAuditLogsInput } from "./dto/hr-core.schemas";
import {
  decodeAuditLogCursor,
  encodeAuditLogCursor,
} from "./hr-audit-cursor";

type AuditLogRow = typeof hrAuditLogs.$inferSelect;

export const HR_AUDIT_LOG_CHUNK = 500;

export interface HrAuditEntry {
  entityType: string;
  entityId: string;
  action: string;
  before?: unknown;
  after?: unknown;
}

type AuditLogPage = {
  data: AuditLogRow[];
  pageInfo: {
    limit: number;
    hasMore: boolean;
    nextCursor: string | null;
  };
};

@Injectable()
export class HrAuditService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  private async resolveMembershipId(
    db: Db,
    orgId: string,
    userId: string,
  ): Promise<number | null> {
    const [row] = await db
      .select({ id: organizationMembers.id })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.orgId, orgId),
          eq(organizationMembers.userId, userId),
        ),
      )
      .limit(1);
    return row?.id ?? null;
  }

  async log(params: {
    orgId: string;
    actorId: string | null;
    actorMembershipId?: number | null;
    entityType: string;
    entityId: string;
    action: string;
    before?: unknown;
    after?: unknown;
    ipAddress?: string;
    userAgent?: string;
  }, tx?: Db): Promise<void> {
    const db = tx ?? this.db;
    let membershipId = params.actorMembershipId ?? null;
    if (membershipId === null && params.actorId !== null) {
      membershipId = await this.resolveMembershipId(db, params.orgId, params.actorId);
    }
    await db.insert(hrAuditLogs).values({
      orgId: params.orgId,
      actorMembershipId: membershipId,
      entityType: params.entityType,
      entityId: params.entityId,
      action: params.action,
      before: params.before ?? null,
      after: params.after ?? null,
      ipAddress: params.ipAddress ?? null,
      userAgent: params.userAgent ?? null,
    });
  }

  /**
   * One multi-row INSERT for a batch that shares an organisation and an actor,
   * which is the shape every sweep produces. `log` in a loop cost one INSERT per
   * entry plus one membership lookup per entry for the same actor; this resolves
   * the membership once and writes the batch under {@link HR_AUDIT_LOG_CHUNK}.
   */
  async logMany(
    params: {
      orgId: string;
      actorId: string | null;
      actorMembershipId?: number | null;
      ipAddress?: string;
      userAgent?: string;
      entries: readonly HrAuditEntry[];
    },
    tx?: Db,
  ): Promise<void> {
    if (params.entries.length === 0) return;
    const db = tx ?? this.db;
    let membershipId = params.actorMembershipId ?? null;
    if (membershipId === null && params.actorId !== null)
      membershipId = await this.resolveMembershipId(db, params.orgId, params.actorId);

    const rows = params.entries.map((entry) => ({
      orgId: params.orgId,
      actorMembershipId: membershipId,
      entityType: entry.entityType,
      entityId: entry.entityId,
      action: entry.action,
      before: entry.before ?? null,
      after: entry.after ?? null,
      ipAddress: params.ipAddress ?? null,
      userAgent: params.userAgent ?? null,
    }));

    for (let offset = 0; offset < rows.length; offset += HR_AUDIT_LOG_CHUNK)
      await db.insert(hrAuditLogs).values(rows.slice(offset, offset + HR_AUDIT_LOG_CHUNK));
  }

  async list(orgId: string, input: ListAuditLogsInput): Promise<AuditLogPage> {
    const {
      cursor: encodedCursor,
      limit,
      entityType,
      entityId,
      actorId,
      action,
      fromDate,
      toDate,
    } = input;
    const cursor = encodedCursor
      ? decodeAuditLogCursor(encodedCursor)
      : null;
    const asOf = cursor ? new Date(cursor.asOf) : new Date();

    let actorMembershipId: number | null = null;
    if (actorId) {
      actorMembershipId = await this.resolveMembershipId(this.db, orgId, actorId);
    }

    const conditions = [
      eq(hrAuditLogs.orgId, orgId),
      lte(hrAuditLogs.createdAt, asOf),
    ];
    if (entityType) conditions.push(eq(hrAuditLogs.entityType, entityType));
    if (entityId) conditions.push(eq(hrAuditLogs.entityId, entityId));
    if (actorMembershipId !== null) conditions.push(eq(hrAuditLogs.actorMembershipId, actorMembershipId));
    if (action) conditions.push(eq(hrAuditLogs.action, action));
    if (fromDate) conditions.push(gte(hrAuditLogs.createdAt, new Date(fromDate)));
    if (toDate) conditions.push(lte(hrAuditLogs.createdAt, new Date(toDate)));
    if (cursor) {
      const cursorCreatedAt = new Date(cursor.createdAt);
      const cursorCondition = or(
        lt(hrAuditLogs.createdAt, cursorCreatedAt),
        and(
          eq(hrAuditLogs.createdAt, cursorCreatedAt),
          lt(hrAuditLogs.id, cursor.auditLogId),
        ),
      );
      if (cursorCondition) conditions.push(cursorCondition);
    }

    const where = and(...conditions);
    const rows = await this.db
      .select()
      .from(hrAuditLogs)
      .where(where)
      .orderBy(desc(hrAuditLogs.createdAt), desc(hrAuditLogs.id))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const lastAuditLog = data.at(-1);

    return {
      data,
      pageInfo: {
        limit,
        hasMore,
        nextCursor:
          hasMore && lastAuditLog
            ? encodeAuditLogCursor({
                asOf: asOf.toISOString(),
                createdAt: lastAuditLog.createdAt.toISOString(),
                auditLogId: lastAuditLog.id,
              })
            : null,
      },
    };
  }
}
