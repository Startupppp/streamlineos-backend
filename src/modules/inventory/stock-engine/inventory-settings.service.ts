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
    materials: row.packMaterials ?? false,
    quickCommerce: row.packQuickCommerce ?? false,
  },
  gstMode: row.gstMode ?? "REGULAR",
  nearExpiryPolicy: row.nearExpiryPolicy ?? "DEPRIORITIZE",
  nearExpiryWindowDays: row.nearExpiryWindowDays ?? 30,
  gstEinvoiceEnabled: row.gstEinvoiceEnabled ?? false,
  gstEwaybillEnabled: row.gstEwaybillEnabled ?? false,
  tallyExportEnabled: row.tallyExportEnabled ?? false,
  complianceAdapter: row.complianceAdapter ?? "stub",
  pharmacyH1RegisterEnabled: row.pharmacyH1RegisterEnabled ?? false,
  qcZeptoEmailPoEnabled: row.qcZeptoEmailPoEnabled ?? false,
  asnRequiredForGrn: row.asnRequiredForGrn ?? false,
  wavelessPicking: row.wavelessPicking ?? false,
  wavelessMaxLines: row.wavelessMaxLines ?? 50,
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
  packMaterials: false,
  packQuickCommerce: false,
  gstMode: "REGULAR",
  nearExpiryPolicy: "DEPRIORITIZE",
  nearExpiryWindowDays: 30,
  gstEinvoiceEnabled: false,
  gstEwaybillEnabled: false,
  tallyExportEnabled: false,
  complianceAdapter: "stub",
  pharmacyH1RegisterEnabled: false,
  qcZeptoEmailPoEnabled: false,
  asnRequiredForGrn: false,
  wavelessPicking: false,
  wavelessMaxLines: 50,
});

/**
 * The settings an organisation has before it changes anything, as the engine
 * sees them.
 *
 * Exported for fixtures. A spec that hand-copies this list drifts from it the
 * moment a field is added — `pack-flags.spec.ts` did, and the drift is invisible
 * because ts-jest runs with `isolatedModules` and never typechecks a spec. Worse
 * than the breakage: a hand-copied default can disagree with the real one, so
 * the test passes against behaviour the product does not have.
 */
export function defaultInvSettingsRow(): InvSettingsRow {
  return toSettingsRow(buildDefaults("fixture-org"));
}

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
      return toSettingsRow(existing ?? buildDefaults(orgId));
    }, CACHE_TTL.MEDIUM);
  }

  /**
   * Applies a patch, creating the row if it is not there.
   *
   * An UPDATE here silently wrote nothing whenever the organisation had no
   * `inv_settings` row, and `get` above is *cached*, so a cache hit was not
   * evidence the row existed: any request that read settings inside a
   * transaction that later rolled back left the value in Redis and no row in the
   * table. The next settings PATCH then updated zero rows, re-seeded the
   * defaults through `get`, and returned them — so the caller saw a successful
   * save and the flag they had just turned on was still off. E3's pack flip
   * failed exactly this way in the seeded suite.
   *
   * Written as an upsert on the tenant key rather than a read-then-branch,
   * because the read-then-branch is the same race one process later.
   */
  async update(orgId: string, patch: Partial<InvSettingsInsert>, actorUserId: string): Promise<InvSettingsRow> {
    const before = await this.get(orgId);
    // Drizzle refuses an empty `set`, and a PATCH carrying no fields is a no-op
    // rather than an error — it has nothing to record and nothing to audit.
    if (Object.keys(patch).length === 0) return before;
    await this.db
      .insert(invSettings)
      .values({ ...buildDefaults(orgId), ...patch })
      .onConflictDoUpdate({
        target: invSettings.orgId,
        set: { ...patch, updatedAt: new Date() },
      });
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
