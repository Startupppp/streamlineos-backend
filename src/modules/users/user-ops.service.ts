import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, count, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { randomUUID, randomBytes } from "node:crypto";
import { addHours } from "date-fns";
import { hashToken } from "../../common/security/token.util";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AuditService } from "../../common/audit/audit.service";
import { CacheService } from "../../common/cache/cache.service";
import { InvitationsService } from "../organization/invitations.service";
import {
  invitations,
  magicLinkTokens,
  organizationMembers,
  users,
} from "../../db/schema";
import type { BulkUpdateUsersInput, ImportUsersRow } from "./dto/users.schemas";
import { UsersService } from "./users.service";

@Injectable()
export class UserOpsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
    private readonly invitationsSvc: InvitationsService,
    private readonly usersSvc: UsersService,
  ) {}

  async exportUsers(orgId: string): Promise<string> {
    const data = await this.db
      .select({
        id: users.id,
        email: users.email,
        firstName: users.firstName,
        lastName: users.lastName,
        role: organizationMembers.role,
        isActive: users.isActive,
        emailVerified: users.emailVerified,
        departmentId: users.departmentId,
        designation: users.designation,
        phone: users.phone,
        joinedAt: organizationMembers.joinedAt,
        createdAt: users.createdAt,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(organizationMembers.userId, users.id))
      .where(eq(organizationMembers.orgId, orgId))
      .orderBy(desc(organizationMembers.joinedAt));

    const headers = [
      "id", "email", "firstName", "lastName", "role", "isActive",
      "emailVerified", "departmentId", "designation", "phone", "joinedAt", "createdAt",
    ];
    const rows = data.map((u) =>
      headers
        .map((h) => {
          const val = (u as Record<string, unknown>)[h];
          if (val === null || val === undefined) return "";
          if (val instanceof Date) return val.toISOString();
          return String(val).replace(/,/g, ";");
        })
        .join(","),
    );

    return [headers.join(","), ...rows].join("\n");
  }

  async getStats(orgId: string) {
    const cacheKey = `users:stats:${orgId}`;

    return this.cache.cached(
      cacheKey,
      async () => {
        const [totalResult, activeResult, suspendedResult, pendingResult, newThisMonthResult] =
          await Promise.all([
            this.db
              .select({ count: count() })
              .from(organizationMembers)
              .where(eq(organizationMembers.orgId, orgId)),
            this.db
              .select({ count: count() })
              .from(organizationMembers)
              .innerJoin(users, eq(organizationMembers.userId, users.id))
              .where(and(eq(organizationMembers.orgId, orgId), eq(users.isActive, true))),
            this.db
              .select({ count: count() })
              .from(organizationMembers)
              .innerJoin(users, eq(organizationMembers.userId, users.id))
              .where(and(eq(organizationMembers.orgId, orgId), eq(users.isActive, false))),
            this.db
              .select({ count: count() })
              .from(invitations)
              .where(and(eq(invitations.orgId, orgId), isNull(invitations.acceptedAt))),
            this.db
              .select({ count: count() })
              .from(organizationMembers)
              .where(
                and(
                  eq(organizationMembers.orgId, orgId),
                  gte(organizationMembers.joinedAt, sql`DATE_TRUNC('month', NOW())`),
                ),
              ),
          ]);

        return {
          total: totalResult[0]?.count ?? 0,
          active: activeResult[0]?.count ?? 0,
          suspended: suspendedResult[0]?.count ?? 0,
          pendingInvitations: pendingResult[0]?.count ?? 0,
          newThisMonth: newThisMonthResult[0]?.count ?? 0,
        };
      },
      60,
    );
  }

  async bulkSuspend(orgId: string, userIds: string[], actorUserId: string) {
    const results: Array<{ userId: string; success: boolean; error?: string }> = [];
    for (const userId of userIds) {
      try {
        await this.usersSvc.updateUserStatus(orgId, userId, "suspended", actorUserId);
        results.push({ userId, success: true });
      } catch {
        results.push({ userId, success: false, error: "Failed to suspend" });
      }
    }
    return {
      results,
      succeeded: results.filter((r) => r.success).length,
      failed: results.filter((r) => !r.success).length,
    };
  }

  async bulkArchive(orgId: string, userIds: string[], actorUserId: string) {
    const results: Array<{ userId: string; success: boolean; error?: string }> = [];
    for (const userId of userIds) {
      try {
        await this.usersSvc.updateUserStatus(orgId, userId, "archived", actorUserId);
        results.push({ userId, success: true });
      } catch {
        results.push({ userId, success: false, error: "Failed to archive" });
      }
    }
    return {
      results,
      succeeded: results.filter((r) => r.success).length,
      failed: results.filter((r) => !r.success).length,
    };
  }

  async bulkRestore(orgId: string, userIds: string[], actorUserId: string) {
    const results: Array<{ userId: string; success: boolean; error?: string }> = [];
    for (const userId of userIds) {
      try {
        await this.usersSvc.updateUserStatus(orgId, userId, "active", actorUserId);
        results.push({ userId, success: true });
      } catch {
        results.push({ userId, success: false, error: "Failed to restore" });
      }
    }
    return {
      results,
      succeeded: results.filter((r) => r.success).length,
      failed: results.filter((r) => !r.success).length,
    };
  }

  async bulkUpdateUsers(orgId: string, data: BulkUpdateUsersInput, actorUserId: string) {
    const { userIds, role, departmentId, branchId, teamId, managerUserId } = data;

    const memberRows = await this.db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.orgId, orgId), inArray(organizationMembers.userId, userIds)));
    const scopedIds = memberRows.map((r) => r.userId);

    if (scopedIds.length === 0) {
      return { success: true, updated: 0 };
    }

    const userUpdate: Record<string, unknown> = {};
    if (departmentId !== undefined) userUpdate.departmentId = departmentId;
    if (branchId !== undefined) userUpdate.branchId = branchId;
    if (managerUserId !== undefined) userUpdate.reportingTo = managerUserId;
    if (teamId !== undefined) userUpdate.team = teamId;

    if (Object.keys(userUpdate).length > 0) {
      await this.db.update(users).set(userUpdate).where(inArray(users.id, scopedIds));
    }

    if (role) {
      await this.db
        .update(organizationMembers)
        .set({ role })
        .where(
          and(
            eq(organizationMembers.orgId, orgId),
            inArray(organizationMembers.userId, scopedIds),
          ),
        );
    }

    this.audit.log({
      action: "user.bulk_updated",
      userId: actorUserId,
      orgId,
      targetType: "user",
      metadata: { userIds: scopedIds, changes: { role, departmentId, branchId, teamId, managerUserId } },
    });

    return { success: true, updated: scopedIds.length };
  }

  async sendSigninLink(orgId: string, userId: string, actorUserId: string) {
    await this.usersSvc.getUser(orgId, userId);

    const user = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { email: true },
    });
    if (!user) throw new NotFoundException("User not found");

    const rawToken = randomBytes(32).toString("hex");
    const tokenHash = hashToken(rawToken);

    await this.db.insert(magicLinkTokens).values({
      id: randomUUID(),
      userId,
      tokenHash,
      expiresAt: addHours(new Date(), 24),
    });

    this.audit.log({
      action: "user.signin_link_sent",
      userId: actorUserId,
      orgId,
      targetId: userId,
      targetType: "user",
      metadata: { email: user.email },
    });

    return { success: true, email: user.email };
  }

  async importUsers(orgId: string, rows: ImportUsersRow[], actorUserId: string) {
    const results: Array<{
      email: string;
      success: boolean;
      error?: string;
      invitationId?: string;
    }> = [];

    for (const row of rows) {
      try {
        const result = await this.invitationsSvc.invite(
          orgId,
          actorUserId,
          row.email,
          row.role ?? "MEMBER",
        );
        results.push({ email: row.email, success: true, invitationId: result.invitationId });
      } catch (err) {
        results.push({
          email: row.email,
          success: false,
          error: err instanceof Error ? err.message : "Unknown error",
        });
      }
    }

    const succeeded = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    this.audit.log({
      action: "user.bulk_imported",
      userId: actorUserId,
      orgId,
      metadata: { total: rows.length, succeeded, failed },
    });

    return { results, succeeded, failed, total: rows.length };
  }
}
