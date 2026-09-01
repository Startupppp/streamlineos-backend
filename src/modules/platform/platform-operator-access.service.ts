import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, gt, isNull, lte } from "drizzle-orm";
import {
  organizationMembers,
  operatorAccessGrants,
  operatorAccessLog,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { runInNewTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";

export type OperatorScope =
  | "read_customer_data"
  | "read_messages"
  | "read_payments"
  | "read_leads"
  | "manage_subscription";

const MAX_GRANT_DURATION_MS = 4 * 60 * 60 * 1000;

export interface GrantParams {
  operatorUserId: string;
  orgId: string;
  incidentRef: string;
  reason: string;
  grantedBy: string;
  scope: OperatorScope;
  expiresAt: Date;
}

@Injectable()
export class PlatformOperatorAccessService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly notifications: NotificationDispatchService,
  ) {}

  async createGrant(params: GrantParams): Promise<string> {
    return this.createGrantAndLog(params, undefined);
  }

  /**
   * Creates the grant request and its management audit event in one tenant
   * transaction. A request must never become visible without its immutable
   * `grant.requested` record.
   */
  async createGrantAndLog(
    params: GrantParams,
    ipAddress: string | undefined,
    detail?: Record<string, unknown>,
  ): Promise<string> {
    this.assertReason(params.reason, params.incidentRef);
    if (params.expiresAt <= new Date())
      throw new BadRequestException("Grant expiry must be in the future");
    const maxExpiry = new Date(Date.now() + MAX_GRANT_DURATION_MS);
    if (params.expiresAt > maxExpiry)
      throw new BadRequestException(
        "Grant duration cannot exceed 4 hours from now",
      );

    return runInNewTenantTransaction(this.db, params.orgId, async (tx) => {
      const [member] = await tx
        .select({ userId: organizationMembers.userId })
        .from(organizationMembers)
        .where(and(
          eq(organizationMembers.orgId, params.orgId),
          eq(organizationMembers.userId, params.operatorUserId),
          eq(organizationMembers.status, "ACTIVE"),
        ))
        .limit(1);
      if (!member)
        throw new ForbiddenException("Target operator is not an active member of the organization");

      const [row] = await tx
        .insert(operatorAccessGrants)
        .values({
          operatorUserId: params.operatorUserId,
          orgId: params.orgId,
          incidentRef: params.incidentRef,
          grantedBy: params.grantedBy,
          scope: params.scope,
          expiresAt: params.expiresAt,
          status: "pending",
        })
        .returning({ grantId: operatorAccessGrants.grantId });

      await tx.insert(operatorAccessLog).values({
        grantId: row!.grantId,
        operatorUserId: params.operatorUserId,
        orgId: params.orgId,
        action: "grant.requested",
        detail: { ...(detail ?? {}), reason: params.reason },
        ipAddress: ipAddress ?? null,
      });

      await this.notifications.emit({
        eventKey: "security.operator_access.requested",
        orgId: params.orgId,
        actorUserId: params.grantedBy,
        targetUserIds: [params.operatorUserId],
        notifySelf: true,
        entityType: "operator_access_grant",
        entityId: row!.grantId,
        title: "Operator access requires approval",
        message: "A break-glass operator access request was created for your organization.",
        priority: "HIGH",
        metadata: { incidentRef: params.incidentRef, scope: params.scope },
      });

      return row!.grantId;
    });
  }

  async approveGrant(
    grantId: string,
    approverId: string,
    ipAddress?: string,
  ): Promise<{ orgId: string; operatorUserId: string }> {
    const [grant] = await this.db
      .select({
        grantId: operatorAccessGrants.grantId,
        grantedBy: operatorAccessGrants.grantedBy,
        approverId: operatorAccessGrants.approverId,
        status: operatorAccessGrants.status,
        orgId: operatorAccessGrants.orgId,
        operatorUserId: operatorAccessGrants.operatorUserId,
      })
      .from(operatorAccessGrants)
      .where(eq(operatorAccessGrants.grantId, grantId))
      .limit(1);
    if (!grant) throw new NotFoundException("Grant not found");
    if (grant.status === "active" && grant.approverId === approverId)
      return { orgId: grant.orgId, operatorUserId: grant.operatorUserId };
    if (grant.status !== "pending") throw new ConflictException("Grant is not in pending status");
    if (grant.grantedBy === approverId)
      throw new ForbiddenException("Self-approval not permitted: approverId must differ from the requester");
    await runInNewTenantTransaction(this.db, grant.orgId, async (tx) => {
      const updated = await tx
        .update(operatorAccessGrants)
        .set({ status: "active", approverId })
        .where(
          and(
            eq(operatorAccessGrants.grantId, grantId),
            eq(operatorAccessGrants.status, "pending"),
            isNull(operatorAccessGrants.revokedAt),
            gt(operatorAccessGrants.expiresAt, new Date()),
          ),
        )
        .returning({ grantId: operatorAccessGrants.grantId });
      if (!updated?.[0])
        throw new ConflictException("Grant was changed before approval completed");
      await tx.insert(operatorAccessLog).values({
        grantId,
        operatorUserId: approverId,
        orgId: grant.orgId,
        action: "grant.approved",
        detail: { operatorUserId: grant.operatorUserId },
        ipAddress: ipAddress ?? null,
      });
    });
    return { orgId: grant.orgId, operatorUserId: grant.operatorUserId };
  }

  async rejectGrant(grantId: string, reason: string, actorId: string, ipAddress?: string): Promise<void> {
    this.assertReason(reason);
    const [grant] = await this.db
      .select({ grantId: operatorAccessGrants.grantId, status: operatorAccessGrants.status })
      .from(operatorAccessGrants)
      .where(eq(operatorAccessGrants.grantId, grantId))
      .limit(1);
    if (!grant) throw new NotFoundException("Grant not found");
    if (grant.status === "rejected") return;
    if (grant.status !== "pending") throw new ConflictException("Grant is not in pending status");
    const [grantOrg] = await this.db
      .select({ orgId: operatorAccessGrants.orgId, operatorUserId: operatorAccessGrants.operatorUserId })
      .from(operatorAccessGrants)
      .where(eq(operatorAccessGrants.grantId, grantId))
      .limit(1);
    if (!grantOrg) throw new NotFoundException("Grant not found");
    await runInNewTenantTransaction(this.db, grantOrg.orgId, async (tx) => {
      const updated = await tx
        .update(operatorAccessGrants)
        .set({ status: "rejected", revokedAt: new Date(), revocationReason: reason })
        .where(and(
          eq(operatorAccessGrants.grantId, grantId),
          eq(operatorAccessGrants.status, "pending"),
          isNull(operatorAccessGrants.revokedAt),
        ))
        .returning({ grantId: operatorAccessGrants.grantId });
      if (!updated?.[0])
        throw new ConflictException("Grant was changed before rejection completed");
      await tx.insert(operatorAccessLog).values({
        grantId,
        operatorUserId: actorId,
        orgId: grantOrg.orgId,
        action: "grant.rejected",
        detail: { operatorUserId: grantOrg.operatorUserId, reason },
        ipAddress: ipAddress ?? null,
      });
    });
  }

  async assertGrant(
    operatorUserId: string,
    orgId: string,
    scope: OperatorScope,
  ): Promise<string> {
    const now = new Date();
    const [grant] = await this.db
      .select({ grantId: operatorAccessGrants.grantId })
      .from(operatorAccessGrants)
      .where(
        and(
          eq(operatorAccessGrants.operatorUserId, operatorUserId),
          eq(operatorAccessGrants.orgId, orgId),
          eq(operatorAccessGrants.scope, scope),
          eq(operatorAccessGrants.status, "active"),
          gt(operatorAccessGrants.expiresAt, now),
          isNull(operatorAccessGrants.revokedAt),
        ),
      )
      .limit(1);
    if (!grant)
      throw new ForbiddenException(
        "No active operator access grant for this organisation and scope",
      );
    return grant.grantId;
  }

  /** Move stale approval requests out of the queue without extending access. */
  async expirePendingGrants(now = new Date()): Promise<number> {
    const grants = await this.db
      .select({ grantId: operatorAccessGrants.grantId, orgId: operatorAccessGrants.orgId, operatorUserId: operatorAccessGrants.operatorUserId })
      .from(operatorAccessGrants)
      .where(and(
        eq(operatorAccessGrants.status, "pending"),
        lte(operatorAccessGrants.expiresAt, now),
        isNull(operatorAccessGrants.revokedAt),
      ));
    let count = 0;
    for (const grant of grants) {
      await runInNewTenantTransaction(this.db, grant.orgId, async (tx) => {
        const expired = await tx
          .update(operatorAccessGrants)
          .set({ status: "expired" })
          .where(and(
            eq(operatorAccessGrants.grantId, grant.grantId),
            eq(operatorAccessGrants.status, "pending"),
            lte(operatorAccessGrants.expiresAt, now),
            isNull(operatorAccessGrants.revokedAt),
          ))
          .returning({ grantId: operatorAccessGrants.grantId });
        if (!expired?.[0]) return;
        count += 1;
        await tx.insert(operatorAccessLog).values({
          grantId: grant.grantId,
          operatorUserId: "system",
          orgId: grant.orgId,
          action: "grant.expired",
          detail: { operatorUserId: grant.operatorUserId },
          ipAddress: null,
        });
      });
    }
    return count;
  }

  async recordAccess(
    grantId: string,
    operatorUserId: string,
    orgId: string,
    action: string,
    ipAddress: string | undefined,
    detail?: Record<string, unknown>,
  ): Promise<void> {
    await this.db.insert(operatorAccessLog).values({
      grantId,
      operatorUserId,
      orgId,
      action,
      detail: detail ?? null,
      ipAddress: ipAddress ?? null,
    });
  }

  async assertAndLog(
    operatorUserId: string,
    orgId: string,
    scope: OperatorScope,
    action: string,
    ipAddress: string | undefined,
    detail?: Record<string, unknown>,
  ): Promise<void> {
    const grantId = await this.assertGrant(operatorUserId, orgId, scope);
    await this.recordAccess(grantId, operatorUserId, orgId, action, ipAddress, detail);
  }

  async authorizeRequest(
    operatorUserId: string,
    orgId: string,
    scope: OperatorScope,
    action: string,
    ipAddress: string | undefined,
  ): Promise<void> {
    await runInNewTenantTransaction(this.db, orgId, async (tx) => {
      const now = new Date();
      const [grant] = await tx
        .select({ grantId: operatorAccessGrants.grantId })
        .from(operatorAccessGrants)
        .where(
          and(
            eq(operatorAccessGrants.operatorUserId, operatorUserId),
            eq(operatorAccessGrants.orgId, orgId),
            eq(operatorAccessGrants.scope, scope),
            eq(operatorAccessGrants.status, "active"),
            gt(operatorAccessGrants.expiresAt, now),
            isNull(operatorAccessGrants.revokedAt),
          ),
        )
        .limit(1);
      if (!grant)
        throw new ForbiddenException(
          "No active operator access grant for this organisation and scope",
        );

      await tx.insert(operatorAccessLog).values({
        grantId: grant.grantId,
        operatorUserId,
        orgId,
        action,
        ipAddress: ipAddress ?? null,
      });
    });
  }

  async revokeGrant(grantId: string, reason: string, actorId: string, ipAddress?: string): Promise<void> {
    this.assertReason(reason);
    const [existing] = await this.db
      .select({ grantId: operatorAccessGrants.grantId })
      .from(operatorAccessGrants)
      .where(eq(operatorAccessGrants.grantId, grantId))
      .limit(1);
    if (!existing) throw new NotFoundException("Grant not found");
    const [grant] = await this.db
      .select({ orgId: operatorAccessGrants.orgId, operatorUserId: operatorAccessGrants.operatorUserId })
      .from(operatorAccessGrants)
      .where(eq(operatorAccessGrants.grantId, grantId))
      .limit(1);
    if (!grant) throw new NotFoundException("Grant not found");
    await runInNewTenantTransaction(this.db, grant.orgId, async (tx) => {
      const revoked = await tx
        .update(operatorAccessGrants)
        .set({ status: "revoked", revokedAt: new Date(), revocationReason: reason })
        .where(and(
          eq(operatorAccessGrants.grantId, grantId),
          eq(operatorAccessGrants.status, "active"),
          isNull(operatorAccessGrants.revokedAt),
        ))
        .returning({ grantId: operatorAccessGrants.grantId });
      if (!revoked?.[0])
        throw new ConflictException("Grant was changed before revocation completed");
      await tx.insert(operatorAccessLog).values({
        grantId,
        operatorUserId: actorId,
        orgId: grant.orgId,
        action: "grant.revoked",
        detail: { operatorUserId: grant.operatorUserId, reason },
        ipAddress: ipAddress ?? null,
      });
    });
  }

  private assertReason(reason: string, incidentRef?: string): void {
    const normalized = reason.trim();
    if (normalized.length < 3 || normalized.length > 1000)
      throw new BadRequestException("Grant reason must be between 3 and 1000 characters");
    if (incidentRef && normalized.toLowerCase() === incidentRef.trim().toLowerCase())
      throw new BadRequestException("Grant reason must be distinct from incident reference");
  }

  async listGrants(orgId: string, status?: string) {
    const now = new Date();
    const conditions = status
      ? and(
          eq(operatorAccessGrants.orgId, orgId),
          eq(operatorAccessGrants.status, status),
          isNull(operatorAccessGrants.revokedAt),
        )
      : and(
          eq(operatorAccessGrants.orgId, orgId),
          eq(operatorAccessGrants.status, "active"),
          gt(operatorAccessGrants.expiresAt, now),
          isNull(operatorAccessGrants.revokedAt),
        );

    return this.db
      .select({
        grantId: operatorAccessGrants.grantId,
        operatorUserId: operatorAccessGrants.operatorUserId,
        incidentRef: operatorAccessGrants.incidentRef,
        grantedBy: operatorAccessGrants.grantedBy,
        approverId: operatorAccessGrants.approverId,
        scope: operatorAccessGrants.scope,
        status: operatorAccessGrants.status,
        expiresAt: operatorAccessGrants.expiresAt,
        createdAt: operatorAccessGrants.createdAt,
      })
      .from(operatorAccessGrants)
      .where(conditions);
  }

  async listLogs(orgId: string, limit = 100) {
    return this.db
      .select({
        logId: operatorAccessLog.logId,
        grantId: operatorAccessLog.grantId,
        operatorUserId: operatorAccessLog.operatorUserId,
        action: operatorAccessLog.action,
        ipAddress: operatorAccessLog.ipAddress,
        accessedAt: operatorAccessLog.accessedAt,
      })
      .from(operatorAccessLog)
      .where(eq(operatorAccessLog.orgId, orgId))
      .orderBy(operatorAccessLog.accessedAt)
      .limit(Math.min(limit, 500));
  }
}
