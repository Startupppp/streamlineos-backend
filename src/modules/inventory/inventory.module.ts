import { Module } from "@nestjs/common";
import { InvProductsModule } from "./products/inv-products.module";
import { InvWarehousesModule } from "./warehouses/inv-warehouses.module";
import { InvStockModule } from "./stock/inv-stock.module";
import { InvVendorsModule } from "./vendors/inv-vendors.module";
import { InvPurchaseOrdersModule } from "./purchase-orders/inv-purchase-orders.module";
import { InvSalesOrdersModule } from "./sales-orders/inv-sales-orders.module";
import { InvReportsModule } from "./reports/inv-reports.module";
import { InvBarcodeModule } from "./barcode/inv-barcode.module";
import { InvCountsModule } from "./counts/inv-counts.module";
import { InvReturnsModule } from "./returns/inv-returns.module";
import { InvTraceabilityModule } from "./traceability/inv-traceability.module";
import { InvValuationModule } from "./valuation/inv-valuation.module";
import { InvLandedCostModule } from "./landed-cost/inv-landed-cost.module";
import { InvLabelsModule } from "./labels/inv-labels.module";
import { InvReconciliationModule } from "./reconciliation/inv-reconciliation.module";
import { InvReplenishmentModule } from "./replenishment/inv-replenishment.module";
import { InvAiModule } from "./ai/inv-ai.module";
import { InvQualityModule } from "./quality/inv-quality.module";
import { InvNotificationsModule } from "./notifications/inv-notifications.module";
import { InvComplianceModule } from "./compliance/inv-compliance.module";
import { InvObservabilityModule } from "./observability/inv-observability.module";
import { InvShipmentsModule } from "./shipments/inv-shipments.module";
import { InvChannelsModule } from "./channels/inv-channels.module";
import { InvImportExportModule } from "./import-export/inv-import-export.module";
import { InvAuditModule } from "./audit/inv-audit.module";
import { InvAuditExportModule } from "./audit-export/inv-audit-export.module";
import { InvWebhooksModule } from "./webhooks/inv-webhooks.module";
import { InvSettingsModule } from "./settings/inv-settings.module";
import { InvPickingModule } from "./picking/inv-picking.module";
import { InvPutawayModule } from "./putaway/inv-putaway.module";
import { InvSyncModule } from "./sync/inv-sync.module";
import { InvHandlingUnitsModule } from "./handling-units/inv-handling-units.module";
import { InvSlottingModule } from "./slotting/inv-slotting.module";
import { InvLaborModule } from "./labor/inv-labor.module";
import { InvKittingModule } from "./kitting/inv-kitting.module";
import { InvStockTypesModule } from "./stock-types/inv-stock-types.module";
import { InvDockModule } from "./dock/inv-dock.module";
import { InvWesModule } from "./wes/inv-wes.module";

const INVENTORY_MODULES = [
  InvProductsModule,
  InvWarehousesModule,
  InvStockModule,
  InvVendorsModule,
  InvPurchaseOrdersModule,
  InvSalesOrdersModule,
  InvReportsModule,
  InvBarcodeModule,
  InvCountsModule,
  InvReturnsModule,
  InvTraceabilityModule,
  InvValuationModule,
  InvLandedCostModule,
  InvLabelsModule,
  InvReconciliationModule,
  InvReplenishmentModule,
  InvAiModule,
  InvQualityModule,
  InvNotificationsModule,
  InvComplianceModule,
  InvObservabilityModule,
  InvShipmentsModule,
  InvChannelsModule,
  InvImportExportModule,
  InvAuditModule,
  InvAuditExportModule,
  InvWebhooksModule,
  InvSettingsModule,
  InvPickingModule,
  InvPutawayModule,
  InvSyncModule,
  InvHandlingUnitsModule,
  InvSlottingModule,
  InvLaborModule,
  InvKittingModule,
  InvStockTypesModule,
  InvDockModule,
  InvWesModule,
];

@Module({
  imports: INVENTORY_MODULES,
  exports: INVENTORY_MODULES,
})
export class InventoryModule {}
