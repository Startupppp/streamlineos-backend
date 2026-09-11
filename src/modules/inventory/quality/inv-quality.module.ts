import { Module } from "@nestjs/common";
import { InvStockEngineModule } from "../stock-engine/inv-stock-engine.module";
import { AccountingAdaptersModule } from "../../accounting/adapters/accounting-adapters.module";
import { InspectionsController } from "./inspections.controller";
import { InspectionPlansController } from "./inspection-plans.controller";
import { HoldsController } from "./holds.controller";
import { RecallsController } from "./recalls.controller";
import { InspectionsService } from "./quality-inspections.service";
import { InspectionPlansService } from "./inspection-plans.service";
import { ReceiptInspectionService } from "./receipt-inspection.service";
import { HoldsService } from "./quality-holds.service";
import { RecallsService } from "./quality-recalls.service";
import { RecallSimulationService } from "./recall-simulation.service";

/**
 * D3. `ReceiptInspectionService` is exported because the receipt path calls it:
 * a goods receipt that has to be inspected raises the inspection and quarantines
 * the quantity inside the posting transaction. Cross-module access goes through
 * the service (backend §1) — `grn-post.service.ts` used to insert into
 * `inv_quality_inspections` directly, which is another module writing this one's
 * table.
 */
@Module({
  imports: [InvStockEngineModule, AccountingAdaptersModule],
  controllers: [
    InspectionsController,
    InspectionPlansController,
    HoldsController,
    RecallsController,
  ],
  providers: [
    InspectionsService,
    InspectionPlansService,
    ReceiptInspectionService,
    HoldsService,
    RecallsService,
    RecallSimulationService,
  ],
  exports: [ReceiptInspectionService],
})
export class InvQualityModule {}
