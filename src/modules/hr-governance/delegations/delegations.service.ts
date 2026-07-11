import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, count, desc, eq, gt, isNull, lte, or } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { hrProxyAccess } from "../../../db/schema/hr/governance";
import { HrAuditService } from "../../hr-core/hr-audit.service";
import type { CreateProxyInput, UpdateProxyInput, ListProxiesInput } from "./delegations.dto";

@Injectable()
export class DelegationsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: HrAuditService,
  ) {}

  async listMy(orgId: string, userId: string, input: ListProxiesInput) {
    const { page, limit, scope } = input;
    const offset = (page - 1) * limit;
    const now = new Date();

    const conditions = [
      eq(hrProxyAccess.orgId, orgId),
      or(eq(hrProxyAccess.grantorUserId, userId), eq(hrProxyAccess.proxyUserId, userId)),
      gt(hrProxyAccess.endsAt, now),
    ];
    if (scope) conditions.push(eq(hrProxyAccess.scope, scope));

    const where = and(...conditions);

    const [data, totalResult] = await Promise.all([
      this.db
        .select()
        .from(hrProxyAccess)
        .where(where)
        .orderBy(desc(hrProxyAccess.createdAt))
        .limit(limit)
        .offset(offset),
      this.db.select({ total: count() }).from(hrProxyAccess).where(where),
    ]);

    return { data, total: totalResult[0]?.total ?? 0, page, limit };
  }

  async listOrg(orgId: string, input: ListProxiesInput) {
    const { page, limit, scope, active } = input;
    const offset = (page - 1) * limit;
    const now = new Date();

    const conditions = [eq(hrProxyAccess.orgId, orgId)];
    if (scope) conditions.push(eq(hrProxyAccess.scope, scope));
    if (active) conditions.push(gt(hrProxyAccess.endsAt, now));
    if (active === false) conditions.push(lte(hrProxyAccess.endsAt, now));

    const where = and(...conditions);

    const [data, totalResult] = await Promise.all([
      this.db
        .select()
        .from(hrProxyAccess)
        .where(where)
        .orderBy(desc(hrProxyAccess.createdAt))
        .limit(limit)
        .offset(offset),
      this.db.select({ total: count() }).from(hrProxyAccess).where(where),
    ]);

    return { data, total: totalResult[0]?.total ?? 0, page, limit };
  }

  async create(orgId: string, userId: string, input: CreateProxyInput, ipAddress?: string) {
    const [proxy] = await this.db
      .insert(hrProxyAccess)
      .values({
        orgId,
        grantorUserId: userId,
        proxyUserId: input.proxyUserId,
        scope: input.scope,
        startsAt: new Date(input.startsAt),
        endsAt: new Date(input.endsAt),
        reason: input.reason ?? null,
        disallowSensitive: input.disallowSensitive ?? false,
        createdBy: userId,
        active: true,
      })
      .returning();

    await this.audit.log({
      orgId,
      actorId: userId,
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
