import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { assets, assetReturns } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";

@Injectable()
export class AssetsRecoveryService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async hasPendingRecovery(orgId: string, userId: string): Promise<boolean> {
    const assignedAssets = await this.db
      .select({ id: assets.id })
      .from(assets)
      .where(
        and(
          eq(assets.orgId, orgId),
          eq(assets.assignedTo, userId),
          inArray(assets.status, ["ASSIGNED", "MAINTENANCE"]),
        ),
      )
      .limit(1);

    if (assignedAssets.length > 0) return true;

    const pendingReturns = await this.db
      .select({ id: assetReturns.id })
      .from(assetReturns)
      .where(
        and(
          eq(assetReturns.orgId, orgId),
          eq(assetReturns.userId, userId),
          eq(assetReturns.status, "PENDING"),
        ),
      )
      .limit(1);

    return pendingReturns.length > 0;
  }
}
