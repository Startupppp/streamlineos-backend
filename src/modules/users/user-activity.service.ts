import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, gte, ilike, lte } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { auditLogs, organizationMembers } from "../../db/schema";
import { buildCursorPage, decodeCursor } from "../../common/pagination/cursor";
import { keysetBeforeId } from "../../common/pagination/keyset";
import type { ListAuditInput } from "./dto/users.schemas";

@Injectable()
export class UserActivityService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  private async assertMember(orgId: string, userId: string): Promise<void> {
    const membership = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.userId, userId),
      ),
      columns: { userId: true },
    });
    if (!membership)
      throw new NotFoundException("User not found in this organization");
  }

  async getUserActivity(
    orgId: string,
    userId: string,
    params?: { cursor?: string; limit?: number },
  ) {
    await this.assertMember(orgId, userId);

    const limit = Math.min(params?.limit ?? 20, 100);
    const position = decodeCursor(params?.cursor);

    const conditions = [
      eq(auditLogs.orgId, orgId),
      eq(auditLogs.targetId, userId),
      eq(auditLogs.targetType, "user"),
    ];
    if (position) conditions.push(keysetBeforeId(auditLogs.createdAt, auditLogs.id, position));

    const rows = await this.db
      .select({
        id: auditLogs.id,
        orgId: auditLogs.orgId,
        targetId: auditLogs.targetId,
        actorUserId: auditLogs.actorUserId,
        action: auditLogs.action,
        resourceType: auditLogs.resourceType,
        resourceId: auditLogs.resourceId,
        metadata: auditLogs.metadata,
        ipAddress: auditLogs.ipAddress,
        createdAt: auditLogs.createdAt,
      })
      .from(auditLogs)
      .where(and(...conditions))
      .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
      .limit(limit + 1);

    const page = buildCursorPage(rows, limit, (row) => ({
      sortValue: row.createdAt.toISOString(),
      id: String(row.id),
    }));

    return {
      data: page.data.map((row) => ({
        id: String(row.id),
        orgId: row.orgId ?? "",
        userId: row.targetId ?? "",
        actorUserId: row.actorUserId ?? null,
        action: row.action,
        resourceType: row.resourceType ?? null,
        resourceId: row.resourceId ?? null,
        metadata: row.metadata ?? {},
        ipAddress: row.ipAddress ?? null,
        createdAt: row.createdAt,
      })),
      pagination: page.pagination,
    };
  }

  async getAuditLog(orgId: string, params: ListAuditInput) {
    const { cursor, limit, actorUserId, action, from, to } = params;
    const position = decodeCursor(cursor);

    const conditions = [
      eq(auditLogs.orgId, orgId),
      eq(auditLogs.targetType, "user"),
    ];
    if (actorUserId) conditions.push(eq(auditLogs.actorUserId, actorUserId));
    if (action) conditions.push(ilike(auditLogs.action, `%${action}%`));
    if (from) conditions.push(gte(auditLogs.createdAt, new Date(from)));
    if (to) conditions.push(lte(auditLogs.createdAt, new Date(to)));
    if (position) conditions.push(keysetBeforeId(auditLogs.createdAt, auditLogs.id, position));

    const rows = await this.db
      .select({
        id: auditLogs.id,
        orgId: auditLogs.orgId,
        targetId: auditLogs.targetId,
        actorUserId: auditLogs.actorUserId,
        action: auditLogs.action,
        resourceType: auditLogs.resourceType,
        resourceId: auditLogs.resourceId,
        metadata: auditLogs.metadata,
        ipAddress: auditLogs.ipAddress,
        createdAt: auditLogs.createdAt,
      })
      .from(auditLogs)
      .where(and(...conditions))
      .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
      .limit(limit + 1);

    const page = buildCursorPage(rows, limit, (row) => ({
      sortValue: row.createdAt.toISOString(),
      id: String(row.id),
    }));

    return {
      data: page.data.map((row) => ({
        id: String(row.id),
        orgId: row.orgId ?? "",
        userId: row.targetId ?? "",
        actorUserId: row.actorUserId ?? null,
        action: row.action,
        resourceType: row.resourceType ?? null,
        resourceId: row.resourceId ?? null,
        metadata: row.metadata ?? {},
        ipAddress: row.ipAddress ?? null,
        createdAt: row.createdAt,
      })),
      pagination: page.pagination,
    };
  }

  async getUserAuditLog(orgId: string, userId: string, params: ListAuditInput) {
    await this.assertMember(orgId, userId);

    const { cursor, limit, from, to } = params;
    const position = decodeCursor(cursor);

    const conditions = [
      eq(auditLogs.orgId, orgId),
      eq(auditLogs.targetId, userId),
      eq(auditLogs.targetType, "user"),
    ];
    if (from) conditions.push(gte(auditLogs.createdAt, new Date(from)));
    if (to) conditions.push(lte(auditLogs.createdAt, new Date(to)));
    if (position) conditions.push(keysetBeforeId(auditLogs.createdAt, auditLogs.id, position));

    const rows = await this.db
      .select({
        id: auditLogs.id,
        orgId: auditLogs.orgId,
        targetId: auditLogs.targetId,
        actorUserId: auditLogs.actorUserId,
        action: auditLogs.action,
        resourceType: auditLogs.resourceType,
        resourceId: auditLogs.resourceId,
        metadata: auditLogs.metadata,
        ipAddress: auditLogs.ipAddress,
        createdAt: auditLogs.createdAt,
      })
      .from(auditLogs)
      .where(and(...conditions))
      .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
      .limit(limit + 1);

    const page = buildCursorPage(rows, limit, (row) => ({
      sortValue: row.createdAt.toISOString(),
      id: String(row.id),
    }));

    return {
      data: page.data.map((row) => ({
        id: String(row.id),
        orgId: row.orgId ?? "",
        userId: row.targetId ?? "",
        actorUserId: row.actorUserId ?? null,
        action: row.action,
        resourceType: row.resourceType ?? null,
        resourceId: row.resourceId ?? null,
        metadata: row.metadata ?? {},
        ipAddress: row.ipAddress ?? null,
        createdAt: row.createdAt,
      })),
      pagination: page.pagination,
    };
  }
}
