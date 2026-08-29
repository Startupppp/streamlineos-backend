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
import { InvReconciliationModule } from "./reconciliation/inv-reconciliation.module";
import { InvReplenishmentModule } from "./replenishment/inv-replenishment.module";
import { InvAiModule } from "./ai/inv-ai.module";
import { InvQualityModule } from "./quality/inv-quality.module";
import { InvShipmentsModule } from "./shipments/inv-shipments.module";
import { InvChannelsModule } from "./channels/inv-channels.module";
import { InvImportExportModule } from "./import-export/inv-import-export.module";
import { InvAuditExportModule } from "./audit-export/inv-audit-export.module";
import { InvWebhooksModule } from "./webhooks/inv-webhooks.module";
import { InvSettingsModule } from "./settings/inv-settings.module";
import { InvPickingModule } from "./picking/inv-picking.module";
import { InvPutawayModule } from "./putaway/inv-putaway.module";
import { InvSyncModule } from "./sync/inv-sync.module";

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
  InvReconciliationModule,
  InvReplenishmentModule,
  InvAiModule,
  InvQualityModule,
  InvShipmentsModule,
  InvChannelsModule,
  InvImportExportModule,
  InvAuditExportModule,
  InvWebhooksModule,
  InvSettingsModule,
  InvPickingModule,
  InvPutawayModule,
  InvSyncModule,
];

@Module({
  imports: INVENTORY_MODULES,
  exports: INVENTORY_MODULES,
})
export class InventoryModule {}
