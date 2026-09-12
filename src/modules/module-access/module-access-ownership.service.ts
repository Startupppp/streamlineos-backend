import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import {
  moduleOwnerships,
  organizationMembers,
  ownershipTransfers,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS } from "../../common/cache/cache-keys";
import { AuditService } from "../../common/audit/audit.service";
import {
  assertManagedModule,
  assertModuleEnabled,
  moduleAccessPolicyDeps,
} from "./module-access.helpers";
import { canTransferModuleOwnership } from "./module-standing";
import { moduleOwnershipDenied } from "./module-access-errors";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { AccessService } from "../access/access.service";
import {
  cancelModuleOwnershipTransfer,
  initiateModuleOwnershipTransfer,
  type ModuleOwnershipTransferDeps,
} from "./lib/module-ownership-transfers";

export interface ModuleOwnership {
  moduleKey: string;
  ownerId: string;
  ownerDisplayName: string;
  ownerEmail: string;
  pendingTransfer: {
    transferId: string;
    toUserId: string;
    toDisplayName: string;
    toEmail: string;
    initiatedAt: string;
  } | null;
}

/**
 * Who owns a module, and whether a transfer of it is pending: the cached read
 * the Access screen's ownership tab renders. Opening and withdrawing a transfer
 * write `ownership_transfers` and carry the lifecycle's rules, and live in
 * `lib/module-ownership-transfers.ts`; `assertOwnershipRights` stays private
 * here and is passed to them bound.
 */
@Injectable()
export class ModuleAccessOwnershipService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  private async assertOwnershipRights(
    actor: CurrentUserContext,
    moduleKey: string,
  ): Promise<void> {
    assertManagedModule(moduleKey);
    await assertModuleEnabled(
      moduleAccessPolicyDeps(this.db, this.access),
      actor.orgId,
      moduleKey,
    );
    if (await canTransferModuleOwnership(this.db, actor, moduleKey)) return;
    throw moduleOwnershipDenied();
  }

  async getOwnership(
    actor: CurrentUserContext,
    moduleKey: string,
  ): Promise<ModuleOwnership> {
    await this.assertOwnershipRights(actor, moduleKey);
    return this.cache.cached(
      CACHE_KEYS.moduleAccessOwnership(actor.orgId, moduleKey),
      () => this.fetchOwnership(actor.orgId, moduleKey),
      60,
    );
  }

  private get transferDeps(): ModuleOwnershipTransferDeps {
    return {
      db: this.db,
      cache: this.cache,
      audit: this.audit,
      assertOwnershipRights: (actor, moduleKey) =>
        this.assertOwnershipRights(actor, moduleKey),
    };
  }

  async initiateTransfer(
    actor: CurrentUserContext,
    moduleKey: string,
    toUserId: string,
  ): Promise<{ success: true }> {
    return initiateModuleOwnershipTransfer(this.transferDeps, actor, moduleKey, toUserId);
  }

  async cancelTransfer(
    actor: CurrentUserContext,
    moduleKey: string,
  ): Promise<{ success: true }> {
    return cancelModuleOwnershipTransfer(this.transferDeps, actor, moduleKey);
  }

  private async fetchOwnership(
    orgId: string,
    moduleKey: string,
  ): Promise<ModuleOwnership> {
    const [ownerRow] = await this.db
      .select({
        ownerUserId: organizationMembers.userId,
        ownerMembershipId: moduleOwnerships.ownerMembershipId,
        ownerName: users.name,
        ownerEmail: users.email,
      })
      .from(moduleOwnerships)
      .innerJoin(
        organizationMembers,
        and(
          eq(moduleOwnerships.orgId, organizationMembers.orgId),
          eq(moduleOwnerships.ownerMembershipId, organizationMembers.id),
        ),
      )
      .innerJoin(users, eq(organizationMembers.userId, users.id))
      .where(
        and(
          eq(moduleOwnerships.orgId, orgId),
          eq(moduleOwnerships.moduleKey, moduleKey),
        ),
      )
      .limit(1);

    if (!ownerRow)
      throw new NotFoundException("Module ownership not configured");

    const [pendingRow] = await this.db
      .select({
        id: ownershipTransfers.id,
        toMembershipId: ownershipTransfers.toMembershipId,
        initiatedAt: ownershipTransfers.initiatedAt,
      })
      .from(ownershipTransfers)
      .where(
        and(
          eq(ownershipTransfers.orgId, orgId),
          eq(ownershipTransfers.moduleKey, moduleKey),
          eq(ownershipTransfers.scope, "MODULE"),
          eq(ownershipTransfers.status, "PENDING"),
        ),
      )
      .limit(1);

    let pendingTransfer: ModuleOwnership["pendingTransfer"] = null;

    if (pendingRow) {
      const [toMember] = await this.db
        .select({
          userId: organizationMembers.userId,
          name: users.name,
          email: users.email,
        })
        .from(organizationMembers)
        .innerJoin(users, eq(organizationMembers.userId, users.id))
        .where(
          and(
            eq(organizationMembers.orgId, orgId),
            eq(organizationMembers.id, pendingRow.toMembershipId),
          ),
        )
        .limit(1);

      if (toMember) {
        pendingTransfer = {
          transferId: pendingRow.id,
          toUserId: toMember.userId,
          toDisplayName: toMember.name ?? toMember.email ?? toMember.userId,
          toEmail: toMember.email ?? "",
          initiatedAt: pendingRow.initiatedAt.toISOString(),
        };
      }
    }

    return {
      moduleKey,
      ownerId: ownerRow.ownerUserId,
      ownerDisplayName:
        ownerRow.ownerName ?? ownerRow.ownerEmail ?? ownerRow.ownerUserId,
      ownerEmail: ownerRow.ownerEmail ?? "",
      pendingTransfer,
    };
  }
}
