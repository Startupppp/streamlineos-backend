import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { invSettings, invAuditEvents } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../../common/cache/cache-keys";
import type { InvSettingsRow } from "./stock-engine.types";

type InvSettingsInsert = typeof invSettings.$inferInsert;
type InvSettingsSelect = typeof invSettings.$inferSelect;

const toSettingsRow = (row: InvSettingsSelect | InvSettingsInsert): InvSettingsRow => ({
  allowNegativeStock: row.allowNegativeStock ?? false,
  allowBackorders: row.allowBackorders ?? false,
  reservationStrategy: row.reservationStrategy ?? "AUTO_ON_CONFIRM",
  defaultCostingMethod: row.defaultCostingMethod ?? "WEIGHTED_AVERAGE",
  expiryReservationPolicy: row.expiryReservationPolicy ?? "BLOCK",
  inspectionOnReceipt: row.inspectionOnReceipt ?? false,
  inspectionOnReturn: row.inspectionOnReturn ?? false,
  overReceiptTolerancePct: row.overReceiptTolerancePct ?? "0.00",
  requirePoApproval: row.requirePoApproval ?? false,
  adjustmentApprovalThreshold: row.adjustmentApprovalThreshold ?? null,
  autoReserveOnConfirm: row.autoReserveOnConfirm ?? true,
  allowPartialShipment: row.allowPartialShipment ?? true,
  packageRequiredForShipping: row.packageRequiredForShipping ?? false,
  channelPublishPolicy: row.channelPublishPolicy ?? null,
  packs: {
    warehouse: row.packWarehouse ?? true,
    kirana: row.packKirana ?? false,
    pharmacy: row.packPharmacy ?? false,
    gst: row.packGst ?? false,
  },
  gstMode: row.gstMode ?? "REGULAR",
  nearExpiryPolicy: row.nearExpiryPolicy ?? "DEPRIORITIZE",
  nearExpiryWindowDays: row.nearExpiryWindowDays ?? 30,
  gstEinvoiceEnabled: row.gstEinvoiceEnabled ?? false,
  gstEwaybillEnabled: row.gstEwaybillEnabled ?? false,
  tallyExportEnabled: row.tallyExportEnabled ?? false,
  complianceAdapter: row.complianceAdapter ?? "stub",
});

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
  packWarehouse: true,
  packKirana: false,
  packPharmacy: false,
  packGst: false,
  gstMode: "REGULAR",
  nearExpiryPolicy: "DEPRIORITIZE",
  nearExpiryWindowDays: 30,
  gstEinvoiceEnabled: false,
  gstEwaybillEnabled: false,
  tallyExportEnabled: false,
  complianceAdapter: "stub",
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
      if (existing) return toSettingsRow(existing);

      await this.db.insert(invSettings).values(buildDefaults(orgId)).onConflictDoNothing();
      const seeded = await this.db.query.invSettings.findFirst({ where: eq(invSettings.orgId, orgId) });
      return toSettingsRow(seeded ?? buildDefaults(orgId));
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
      before: { ...before },
      after: { ...before, ...patch },
    });
    await this.cache.invalidate(CACHE_KEYS.invSettings(orgId));
    return this.get(orgId);
  }
}
