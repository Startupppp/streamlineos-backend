import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, gt, isNull } from "drizzle-orm";
import { operatorAccessGrants, operatorAccessLog } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";

export type OperatorScope =
  | "read_customer_data"
  | "read_messages"
  | "read_payments"
  | "read_leads"
  | "manage_subscription";

export interface GrantParams {
  operatorUserId: string;
  orgId: string;
  incidentRef: string;
  grantedBy: string;
  scope: OperatorScope;
  expiresAt: Date;
}

@Injectable()
export class PlatformOperatorAccessService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async createGrant(params: GrantParams): Promise<string> {
    const [row] = await this.db
      .insert(operatorAccessGrants)
      .values({
        operatorUserId: params.operatorUserId,
        orgId: params.orgId,
        incidentRef: params.incidentRef,
        grantedBy: params.grantedBy,
        scope: params.scope,
        expiresAt: params.expiresAt,
      })
      .returning({ grantId: operatorAccessGrants.grantId });
    return row!.grantId;
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

  async revokeGrant(grantId: string, reason: string): Promise<void> {
    const [existing] = await this.db
      .select({ grantId: operatorAccessGrants.grantId })
      .from(operatorAccessGrants)
      .where(eq(operatorAccessGrants.grantId, grantId))
      .limit(1);
    if (!existing) throw new NotFoundException("Grant not found");
    await this.db
      .update(operatorAccessGrants)
      .set({ revokedAt: new Date(), revocationReason: reason })
      .where(eq(operatorAccessGrants.grantId, grantId));
  }

  async listActiveGrants(orgId: string) {
    const now = new Date();
    return this.db
      .select({
        grantId: operatorAccessGrants.grantId,
        operatorUserId: operatorAccessGrants.operatorUserId,
        incidentRef: operatorAccessGrants.incidentRef,
        grantedBy: operatorAccessGrants.grantedBy,
        scope: operatorAccessGrants.scope,
        expiresAt: operatorAccessGrants.expiresAt,
        createdAt: operatorAccessGrants.createdAt,
      })
      .from(operatorAccessGrants)
      .where(
        and(
          eq(operatorAccessGrants.orgId, orgId),
          gt(operatorAccessGrants.expiresAt, now),
          isNull(operatorAccessGrants.revokedAt),
        ),
      );
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
