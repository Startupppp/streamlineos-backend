import { Module } from "@nestjs/common";
import { InvStockEngineModule } from "../stock-engine/inv-stock-engine.module";
import { AccountingAdaptersModule } from "../../accounting/adapters/accounting-adapters.module";
import { InspectionsController } from "./inspections.controller";
import { HoldsController } from "./holds.controller";
import { RecallsController } from "./recalls.controller";
import { InspectionsService } from "./quality-inspections.service";
import { HoldsService } from "./quality-holds.service";
import { RecallsService } from "./quality-recalls.service";

@Module({
  imports: [InvStockEngineModule, AccountingAdaptersModule],
  controllers: [InspectionsController, HoldsController, RecallsController],
  providers: [InspectionsService, HoldsService, RecallsService],
})
export class InvQualityModule {}
