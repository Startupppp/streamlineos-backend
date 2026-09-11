import { Inject, Injectable } from "@nestjs/common";
import { and, count, desc, eq } from "drizzle-orm";
import {
  organizationMembers,
  ownershipTransfers,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AuditService } from "../../common/audit/audit.service";
import { CacheService } from "../../common/cache/cache.service";
import { stableHash } from "../../common/cache/cache-hash";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import { OwnershipTransferExpiryService } from "./ownership-transfer-expiry.service";
import {
  initiateModuleTransfer,
  initiateOrgTransfer,
  type TransferInitiationDeps,
} from "./lib/ownership-transfer-initiation";
import type {
  InitiateModuleTransferInput,
  InitiateOrgTransferInput,
  ListTransfersInput,
} from "./dto/ownership.schemas";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

@Injectable()
export class OwnershipTransfersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
    private readonly dispatch: NotificationDispatchService,
    private readonly expiry: OwnershipTransferExpiryService,
  ) {}

  private get initiationDeps(): TransferInitiationDeps {
    return {
      db: this.db,
      audit: this.audit,
      cache: this.cache,
      dispatch: this.dispatch,
    };
  }

  initiateOrgTransfer(
    orgId: string,
    actorUserId: string,
    input: InitiateOrgTransferInput,
  ) {
    return initiateOrgTransfer(this.initiationDeps, orgId, actorUserId, input);
  }

  initiateModuleTransfer(
    orgId: string,
    actorUserId: string,
    moduleKey: string,
    input: InitiateModuleTransferInput,
    actor: CurrentUserContext,
  ) {
    return initiateModuleTransfer(
      this.initiationDeps,
      orgId,
      actorUserId,
      moduleKey,
      input,
      actor,
    );
  }

  async listTransfers(orgId: string, filters: ListTransfersInput) {
    const hash = stableHash({
      page: filters.page,
      limit: filters.limit,
      scope: filters.scope ?? null,
      status: filters.status ?? null,
    });
    return this.cache.cachedVersionedForOrg(
      orgId,
      "ownership:transfers",
      `list:${hash}`,
      () => this.fetchTransfers(orgId, filters),
      60,
    );
  }

  private async fetchTransfers(orgId: string, filters: ListTransfersInput) {
    const offset = (filters.page - 1) * filters.limit;

    const conditions = [eq(ownershipTransfers.orgId, orgId)];
    if (filters.scope)
      conditions.push(eq(ownershipTransfers.scope, filters.scope));
    if (filters.status)
      conditions.push(eq(ownershipTransfers.status, filters.status));

    const [rows, countResult] = await Promise.all([
      this.db
        .select({
          id: ownershipTransfers.id,
          scope: ownershipTransfers.scope,
          moduleKey: ownershipTransfers.moduleKey,
          fromMembershipId: ownershipTransfers.fromMembershipId,
          initiatedByMembershipId: ownershipTransfers.initiatedByMembershipId,
          toMembershipId: ownershipTransfers.toMembershipId,
          status: ownershipTransfers.status,
          initiatedAt: ownershipTransfers.initiatedAt,
          respondedAt: ownershipTransfers.respondedAt,
          expiresAt: ownershipTransfers.expiresAt,
          reason: ownershipTransfers.reason,
        })
        .from(ownershipTransfers)
        .where(and(...conditions))
        .orderBy(desc(ownershipTransfers.initiatedAt))
        .limit(filters.limit)
        .offset(offset),
      this.db
        .select({ total: count() })
        .from(ownershipTransfers)
        .where(and(...conditions)),
    ]);

    const total = countResult[0]?.total ?? 0;

    return {
      data: rows,
      pagination: {
        page: filters.page,
        limit: filters.limit,
        total,
        totalPages: Math.ceil(total / filters.limit),
      },
    };
  }

  async listIncomingTransfers(orgId: string, userId: string) {
    return this.cache.cachedVersionedForOrg(
      orgId,
      "ownership:transfers",
      `incoming:${userId}`,
      () => this.fetchIncomingTransfers(orgId, userId),
      60,
    );
  }

  private async fetchIncomingTransfers(orgId: string, userId: string) {
    const [membership] = await this.db
      .select({ id: organizationMembers.id })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.orgId, orgId),
          eq(organizationMembers.userId, userId),
        ),
      )
      .limit(1);

    if (!membership) return { data: [] };

    const rows = await this.db
      .select({
        id: ownershipTransfers.id,
        scope: ownershipTransfers.scope,
        moduleKey: ownershipTransfers.moduleKey,
        fromMembershipId: ownershipTransfers.fromMembershipId,
        initiatedByMembershipId: ownershipTransfers.initiatedByMembershipId,
        toMembershipId: ownershipTransfers.toMembershipId,
        status: ownershipTransfers.status,
        initiatedAt: ownershipTransfers.initiatedAt,
        expiresAt: ownershipTransfers.expiresAt,
        reason: ownershipTransfers.reason,
        fromName: users.name,
        fromEmail: users.email,
      })
      .from(ownershipTransfers)
      .leftJoin(
        organizationMembers,
        and(
          eq(organizationMembers.id, ownershipTransfers.fromMembershipId),
          eq(organizationMembers.orgId, orgId),
        ),
      )
      .leftJoin(users, eq(users.id, organizationMembers.userId))
      .where(
        and(
          eq(ownershipTransfers.orgId, orgId),
          eq(ownershipTransfers.toMembershipId, membership.id),
          eq(ownershipTransfers.status, "PENDING"),
        ),
      )
      .orderBy(desc(ownershipTransfers.initiatedAt))
      .limit(20);

    return { data: rows };
  }

  async expireStaleTransfers(): Promise<{ expired: number }> {
    return this.expiry.expireStaleTransfers();
  }
}
