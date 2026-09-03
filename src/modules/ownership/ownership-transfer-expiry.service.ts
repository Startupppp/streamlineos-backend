import { Inject, Injectable } from "@nestjs/common";
import { and, eq, lt } from "drizzle-orm";
import { ownershipTransfers } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { forEachOrg } from "../../common/tenant";
import { logger } from "../../common/logger/logger.service";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import { resolveMembershipUserIdMap } from "./ownership-members.helper";

@Injectable()
export class OwnershipTransferExpiryService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly dispatch: NotificationDispatchService,
  ) {}

  async expireStaleTransfers(): Promise<{ expired: number }> {
    const now = new Date();
    const expired: Array<{
      orgId: string;
      transferId: string;
      targetUserIds: string[];
    }> = [];

    await forEachOrg(
      this.db,
      "ownership-transfer-expiry",
      async (tx, orgId) => {
        const rows = await tx
          .update(ownershipTransfers)
          .set({ status: "EXPIRED" })
          .where(
            and(
              eq(ownershipTransfers.orgId, orgId),
              eq(ownershipTransfers.status, "PENDING"),
              lt(ownershipTransfers.expiresAt, now),
            ),
          )
          .returning({
            id: ownershipTransfers.id,
            fromMembershipId: ownershipTransfers.fromMembershipId,
            toMembershipId: ownershipTransfers.toMembershipId,
            scope: ownershipTransfers.scope,
            moduleKey: ownershipTransfers.moduleKey,
          });
        if (rows.length === 0) return;

        const userIdByMembership = await resolveMembershipUserIdMap(
          tx,
          orgId,
          rows.flatMap((row) => [row.fromMembershipId, row.toMembershipId]),
        );

        const expiredModuleKeys: string[] = [];
        for (const row of rows) {
          const targetUserIds = Array.from(
            new Set(
              [row.fromMembershipId, row.toMembershipId]
                .map((id) => userIdByMembership.get(id))
                .filter((id): id is string => id !== undefined),
            ),
          );
          expired.push({ orgId, transferId: row.id, targetUserIds });
          if (row.scope === "MODULE" && row.moduleKey !== null)
            expiredModuleKeys.push(row.moduleKey);
        }

        await Promise.all([
          this.cache.invalidateNamespaceForOrg(orgId, "ownership:transfers"),
          ...expiredModuleKeys.map((k) =>
            this.cache.invalidateForOrg(orgId, `module-access:ownership:${k}`),
          ),
        ]);
      },
    );

    for (const row of expired) {
      if (row.targetUserIds.length === 0) continue;
      void this.dispatch
        .emit({
          eventKey: "ownership.transfer.expired",
          orgId: row.orgId,
          targetUserIds: row.targetUserIds,
          entityType: "ownership_transfer",
          entityId: row.transferId,
          title: "Ownership transfer expired",
          message:
            "An ownership transfer request expired before it was answered. Ownership is unchanged.",
          link: "/settings/organization",
        })
        .catch((error: unknown) => {
          logger.error("ownership transfer expiry notification failed", {
            error,
            transferId: row.transferId,
            orgId: row.orgId,
          });
        });
    }

    return { expired: expired.length };
  }
}
