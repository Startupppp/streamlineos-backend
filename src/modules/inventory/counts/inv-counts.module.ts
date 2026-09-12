import { Module } from "@nestjs/common";
import { InvStockEngineModule } from "../stock-engine/inv-stock-engine.module";
import { AccountingAdaptersModule } from "../../accounting/adapters/accounting-adapters.module";
import { InvCycleCountsController } from "./inv-cycle-counts.controller";
import { InvPhysicalAuditsController } from "./inv-physical-audits.controller";
import { InvCycleCountsService } from "./inv-cycle-counts.service";
import { InvPhysicalAuditsService } from "./inv-physical-audits.service";

@Module({
  imports: [InvStockEngineModule, AccountingAdaptersModule],
  controllers: [InvCycleCountsController, InvPhysicalAuditsController],
  providers: [InvCycleCountsService, InvPhysicalAuditsService],
})
export class InvCountsModule {}
