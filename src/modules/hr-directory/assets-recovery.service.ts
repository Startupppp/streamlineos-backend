import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, lte, isNotNull } from "drizzle-orm";
import { assets, assetReturns } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { HrAutomationEngineService } from "../hr-automations/hr-automation-engine.service";

@Injectable()
export class AssetsRecoveryService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly hrAutomation: HrAutomationEngineService,
  ) {}

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

  async getPendingAssets(orgId: string, userId: string) {
    return this.db
      .select()
      .from(assets)
      .where(
        and(
          eq(assets.orgId, orgId),
          eq(assets.assignedTo, userId),
          inArray(assets.status, ["ASSIGNED", "MAINTENANCE"]),
        ),
      )
      .limit(50);
  }

  async sweepReturnsDue(orgId: string): Promise<{ swept: number }> {
    const horizonDate = new Date();
    horizonDate.setDate(horizonDate.getDate() + 3);
    const horizon = horizonDate.toISOString().slice(0, 10);

    const dueAssets = await this.db
      .select({
        id: assets.id,
        type: assets.type,
        assignedTo: assets.assignedTo,
        expectedReturnDate: assets.expectedReturnDate,
      })
      .from(assets)
      .where(
        and(
          eq(assets.orgId, orgId),
          inArray(assets.status, ["ASSIGNED", "MAINTENANCE"]),
          isNotNull(assets.expectedReturnDate),
          lte(assets.expectedReturnDate, horizon),
        ),
      )
      .limit(200);

    for (const asset of dueAssets) {
      if (!asset.assignedTo || !asset.expectedReturnDate) continue;
      const daysUntilDue = Math.ceil(
        (new Date(asset.expectedReturnDate).getTime() - Date.now()) / 86_400_000,
      );
      await this.hrAutomation.emit(orgId, "asset.return_due", {
        employeeId: asset.assignedTo,
        assetType: asset.type,
        daysUntilDue,
      });
    }

    return { swept: dueAssets.length };
  }
}
