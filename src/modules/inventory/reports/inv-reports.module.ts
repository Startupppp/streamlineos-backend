import { Module } from "@nestjs/common";
import { InvReportsController } from "./inv-reports.controller";
import { InvReportsService } from "./inv-reports.service";
import { InvReportsExtendedService } from "./inv-reports-extended.service";
import { InvStockEngineModule } from "../stock-engine/inv-stock-engine.module";

@Module({
  // InvReportsService and InvReportsExtendedService inject WarehouseScopeService, which
  // InvStockEngineModule owns. Without this the application cannot boot — DI is resolved
  // at runtime, so typecheck stays green.
  imports: [InvStockEngineModule],
  controllers: [InvReportsController],
  providers: [InvReportsService, InvReportsExtendedService],
  exports: [InvReportsService, InvReportsExtendedService],
})
export class InvReportsModule {}
