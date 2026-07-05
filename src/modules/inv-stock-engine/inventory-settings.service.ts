import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { invSettings, invAuditEvents } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import type { InvSettingsRow } from "./stock-engine.types";

type InvSettingsInsert = typeof invSettings.$inferInsert;

const buildDefaults = (orgId: string): InvSettingsInsert => ({
  orgId,
  allowNegativeStock: false,
  allowBackorders: false,
  reservationStrategy: "AUTO_ON_CONFIRM",
  defaultCostingMethod: "WEIGHTED_AVERAGE",
  expiryReservationPolicy: "BLOCK",
  inspectionOnReceipt: false,
  inspectionOnReturn: false,
  overReceiptTolerancePct: "0.00",
  requirePoApproval: false,
  adjustmentApprovalThreshold: null,
  autoReserveOnConfirm: true,
  allowPartialShipment: true,
  packageRequiredForShipping: false,
  channelPublishPolicy: null,
});

@Injectable()
export class InventorySettingsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  async get(orgId: string): Promise<InvSettingsRow> {
    const key = CACHE_KEYS.invSettings(orgId);
    return this.cache.cached(key, async () => {
      const existing = await this.db.query.invSettings.findFirst({
        where: eq(invSettings.orgId, orgId),
      });
      if (existing) return existing as unknown as InvSettingsRow;

      await this.db.insert(invSettings).values(buildDefaults(orgId)).onConflictDoNothing();
      const seeded = await this.db.query.invSettings.findFirst({ where: eq(invSettings.orgId, orgId) });
      return (seeded ?? buildDefaults(orgId)) as unknown as InvSettingsRow;
    }, CACHE_TTL.MEDIUM);
  }

  async update(orgId: string, patch: Partial<InvSettingsInsert>, actorUserId: string): Promise<InvSettingsRow> {
    const before = await this.get(orgId);
    await this.db.update(invSettings).set(patch).where(eq(invSettings.orgId, orgId));
    await this.db.insert(invAuditEvents).values({
      orgId,
      actorUserId,
      action: "settings.update",
      resourceType: "inv_settings",
      resourceId: orgId,
      before: before as unknown as Record<string, unknown>,
      after: { ...before, ...patch } as Record<string, unknown>,
    });
    await this.cache.invalidate(CACHE_KEYS.invSettings(orgId));
    return this.get(orgId);
  }
}
