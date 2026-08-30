import { Module } from "@nestjs/common";
import { InvStockEngineModule } from "../../stock-engine/inv-stock-engine.module";
import { QuickCommerceController } from "./quick-commerce.controller";
import { QuickCommerceInboundService } from "./quick-commerce-inbound.service";
import { FillRateService } from "./fill-rate.service";

/**
 * NEO-2. Exports the service because the GRN path calls `assertReceivable` — the
 * `asn_required_for_grn` rule has one home, and receiving asks it rather than
 * carrying a copy.
 */
@Module({
  imports: [InvStockEngineModule],
  controllers: [QuickCommerceController],
  providers: [QuickCommerceInboundService, FillRateService],
  exports: [QuickCommerceInboundService, FillRateService],
})
export class InvQuickCommerceModule {}
