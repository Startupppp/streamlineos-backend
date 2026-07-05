import { Module } from "@nestjs/common";
import { VendorReturnsController } from "./vendor-returns.controller";
import { CustomerReturnsController } from "./customer-returns.controller";
import { VendorReturnsService } from "./vendor-returns.service";
import { CustomerReturnsService } from "./customer-returns.service";
import { InvStockEngineModule } from "../inv-stock-engine/inv-stock-engine.module";

@Module({
  imports: [InvStockEngineModule],
  controllers: [VendorReturnsController, CustomerReturnsController],
  providers: [VendorReturnsService, CustomerReturnsService],
  exports: [VendorReturnsService, CustomerReturnsService],
})
export class InvReturnsModule {}
