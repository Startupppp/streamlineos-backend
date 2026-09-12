import { Module } from "@nestjs/common";
import { InvStockEngineModule } from "../stock-engine/inv-stock-engine.module";
import { DockController } from "./dock.controller";
import { DockService } from "./dock.service";

/**
 * NEO-12. Exported because receiving asks `hasAppointmentForAsn` when
 * `asn_required_for_grn` is on - "was this expected" has one answer, and a copy
 * of the question in the GRN path would be a second one.
 */
@Module({
  imports: [InvStockEngineModule],
  controllers: [DockController],
  providers: [DockService],
  exports: [DockService],
})
export class InvDockModule {}
