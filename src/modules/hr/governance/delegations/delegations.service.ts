import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, gt, lte, or } from "drizzle-orm";
import { decodeCursor, buildCursorPage } from "../../../../common/pagination/cursor";
import { keysetBeforeId } from "../../../../common/pagination/keyset";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { Db } from "../../../../db/drizzle.module";
import { hrProxyAccess } from "../../../../db/schema/hr/governance";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { actingMembershipId } from "../../../../common/auth/principal";
import { HrAuditService } from "../../core/hr-audit.service";
import type { CreateProxyInput, UpdateProxyInput, ListProxiesInput } from "./delegations.dto";

@Injectable()
export class DelegationsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: HrAuditService,
  ) {}

  async listMy(u: CurrentUserContext, input: ListProxiesInput) {
    const { cursor, limit, scope } = input;
    const pos = decodeCursor(cursor);
    const now = new Date();
    const membershipId = actingMembershipId(u.principal);
    const actorPredicate = membershipId != null
      ? or(
          eq(hrProxyAccess.grantorMembershipId, membershipId),
          eq(hrProxyAccess.proxyMembershipId, membershipId),
          eq(hrProxyAccess.grantorUserId, u.userId),
          eq(hrProxyAccess.proxyUserId, u.userId),
        )!
      : or(eq(hrProxyAccess.grantorUserId, u.userId), eq(hrProxyAccess.proxyUserId, u.userId))!;

    const conditions = [
      eq(hrProxyAccess.orgId, u.orgId),
      actorPredicate,
      gt(hrProxyAccess.endsAt, now),
    ];
    if (scope) conditions.push(eq(hrProxyAccess.scope, scope));
    if (pos) conditions.push(keysetBeforeId(hrProxyAccess.createdAt, hrProxyAccess.id, pos));

    const rows = await this.db
      .select()
      .from(hrProxyAccess)
      .where(and(...conditions))
      .orderBy(desc(hrProxyAccess.createdAt), desc(hrProxyAccess.id))
      .limit(limit + 1);

    return buildCursorPage(rows, limit, (row) => ({
      sortValue: row.createdAt.toISOString(),
      id: String(row.id),
    }));
  }

  async listOrg(orgId: string, input: ListProxiesInput) {
    const { cursor, limit, scope, active } = input;
    const pos = decodeCursor(cursor);
    const now = new Date();

    const conditions = [eq(hrProxyAccess.orgId, orgId)];
    if (scope) conditions.push(eq(hrProxyAccess.scope, scope));
    if (active) conditions.push(gt(hrProxyAccess.endsAt, now));
    if (active === false) conditions.push(lte(hrProxyAccess.endsAt, now));
    if (pos) conditions.push(keysetBeforeId(hrProxyAccess.createdAt, hrProxyAccess.id, pos));

    const rows = await this.db
      .select()
      .from(hrProxyAccess)
      .where(and(...conditions))
      .orderBy(desc(hrProxyAccess.createdAt), desc(hrProxyAccess.id))
      .limit(limit + 1);

    return buildCursorPage(rows, limit, (row) => ({
      sortValue: row.createdAt.toISOString(),
      id: String(row.id),
    }));
  }

  async create(u: CurrentUserContext, input: CreateProxyInput, ipAddress?: string) {
    const membershipId = actingMembershipId(u.principal);
    const [proxy] = await this.db
      .insert(hrProxyAccess)
      .values({
        orgId: u.orgId,
        grantorUserId: u.userId,
        grantorMembershipId: membershipId,
        proxyUserId: input.proxyUserId,
        scope: input.scope,
        startsAt: new Date(input.startsAt),
        endsAt: new Date(input.endsAt),
        reason: input.reason ?? null,
        disallowSensitive: input.disallowSensitive ?? false,
        createdBy: u.userId,
        active: true,
      })
      .returning();

    await this.audit.log({
      orgId: u.orgId,
      actorId: u.userId,
      entityType: "hr_proxy_access",
      entityId: String(proxy!.id),
      action: "proxy.granted",
      after: { proxyUserId: input.proxyUserId, scope: input.scope },
      ipAddress,
    });

    return proxy!;
  }

  async update(orgId: string, proxyId: number, userId: string, input: UpdateProxyInput, ipAddress?: string) {
    const existing = await this.getById(orgId, proxyId);

    if (existing.grantorUserId !== userId) {
      throw new ForbiddenException("Only the grantor can modify this proxy");
    }

    const [updated] = await this.db
      .update(hrProxyAccess)
      .set({
        ...(input.proxyUserId !== undefined && { proxyUserId: input.proxyUserId }),
        ...(input.scope !== undefined && { scope: input.scope }),
        ...(input.startsAt !== undefined && { startsAt: new Date(input.startsAt) }),
        ...(input.endsAt !== undefined && { endsAt: new Date(input.endsAt) }),
        ...(input.reason !== undefined && { reason: input.reason }),
        ...(input.disallowSensitive !== undefined && { disallowSensitive: input.disallowSensitive }),
        updatedAt: new Date(),
      })
      .where(and(eq(hrProxyAccess.orgId, orgId), eq(hrProxyAccess.id, proxyId)))
      .returning();

    await this.audit.log({
      orgId,
      actorId: userId,
      entityType: "hr_proxy_access",
      entityId: String(proxyId),
      action: "proxy.updated",
      after: input,
      ipAddress,
    });

    return updated!;
  }

  async revoke(orgId: string, proxyId: number, userId: string, isAdmin: boolean, ipAddress?: string) {
    const existing = await this.getById(orgId, proxyId);

    if (!isAdmin && existing.grantorUserId !== userId) {
      throw new ForbiddenException("Only the grantor or an admin can revoke this proxy");
    }

    await this.db
      .update(hrProxyAccess)
      .set({ active: false, endsAt: new Date(), updatedAt: new Date() })
      .where(and(eq(hrProxyAccess.orgId, orgId), eq(hrProxyAccess.id, proxyId)));

    await this.audit.log({
      orgId,
      actorId: userId,
      entityType: "hr_proxy_access",
      entityId: String(proxyId),
      action: "proxy.revoked",
      ipAddress,
    });
  }

  private async getById(orgId: string, proxyId: number) {
    const [row] = await this.db
      .select()
      .from(hrProxyAccess)
      .where(and(eq(hrProxyAccess.orgId, orgId), eq(hrProxyAccess.id, proxyId)))
      .limit(1);

    if (!row) throw new NotFoundException("Proxy access not found");
    return row;
  }
}
