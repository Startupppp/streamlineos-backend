import { Module } from "@nestjs/common";
import { InvStockEngineModule } from "../stock-engine/inv-stock-engine.module";
import { InvBarcodeModule } from "../barcode/inv-barcode.module";
import { CarriersController } from "./carriers.controller";
import { PackagesController } from "./packages.controller";
import { ShipmentsController } from "./shipments.controller";
import { LoadsController } from "./loads.controller";
import { CarriersService } from "./carriers.service";
import { PackagesService } from "./packages.service";
import { ShipmentsService } from "./shipments.service";
import { LoadsService } from "./loads.service";
import { CartonizationService } from "./cartonization.service";
import { CartonizationController } from "./cartonization.controller";
import { CarrierStatusService } from "./carrier-status.service";
import { CarrierStatusController } from "./carrier-status.controller";
import { CarrierAdapterRegistry } from "./carrier-adapter";
import { CarrierTransportController } from "./transport/carrier-transport.controller";
import { CarrierWebhooksPublicController } from "./transport/carrier-webhooks-public.controller";
import { CarrierTransportService } from "./transport/carrier-transport.service";
import { CarrierTransportRegistry } from "./transport/carrier-transport.registry";
import { CarrierCredentialsService } from "./transport/carrier-credentials.service";
import { CarrierWebhookReceiverService } from "./transport/carrier-webhook.service";
import { ReferenceHttpCarrierAdapter } from "./transport/reference-http.adapter";
import { DelhiveryHttpCarrierAdapter } from "./transport/delhivery-http.adapter";

@Module({
  // B6. Packing resolves a scan the way picking does, so the bench accepts the
  // GTIN, SKU, lot or serial label that happens to be on the box.
  imports: [InvStockEngineModule, InvBarcodeModule],
  controllers: [
    CarriersController,
    PackagesController,
    ShipmentsController,
    LoadsController,
    CartonizationController,
    CarrierStatusController,
    // INV-26. The transport surface (book/label/track, credentials, the failure
    // queues) and the public ingest a courier posts to.
    CarrierTransportController,
    CarrierWebhooksPublicController,
  ],
  // B7. The adapter registry is a provider rather than a module-level singleton
  // so a test can register a fake carrier against the real service graph — which
  // is the only way a boundary with no real implementation gets exercised at all.
  //
  // INV-26 adds a second registry beside it, and the two are deliberately not
  // merged: `CarrierAdapterRegistry` resolves the polling adapter by the
  // tenant's own `code` and falls back to manual, while
  // `CarrierTransportRegistry` resolves book/label/track by the `transport`
  // column an administrator sets from a known list. Collapsing them would make
  // a tenant's free-text code a route into a courier integration.
  providers: [
    CarriersService,
    PackagesService,
    ShipmentsService,
    LoadsService,
    CartonizationService,
    CarrierStatusService,
    CarrierAdapterRegistry,
    ReferenceHttpCarrierAdapter,
    DelhiveryHttpCarrierAdapter,
    CarrierTransportRegistry,
    CarrierCredentialsService,
    CarrierTransportService,
    CarrierWebhookReceiverService,
  ],
  exports: [
    CarriersService,
    PackagesService,
    ShipmentsService,
    LoadsService,
    CartonizationService,
    CarrierStatusService,
    CarrierAdapterRegistry,
    CarrierTransportRegistry,
    CarrierTransportService,
  ],
})
export class InvShipmentsModule {}
