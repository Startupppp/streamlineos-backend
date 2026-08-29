import { Module } from "@nestjs/common";
import { InvAiController } from "./inv-ai.controller";
import { InvAiService } from "./inv-ai.service";
import { InvAiExplainController } from "./inv-ai-explain.controller";
import { InvAiExplainService } from "./inv-ai-explain.service";
import { InvCopilotController } from "./copilot/inv-copilot.controller";
import { InvCopilotService } from "./copilot/inv-copilot.service";
import { AiModule } from "../../ai/core/ai.module";
import { AiConfirmationModule } from "../../ai/confirmation/ai-confirmation.module";
import { InvReplenishmentModule } from "../replenishment/inv-replenishment.module";
import { InvVendorsModule } from "../vendors/inv-vendors.module";
import { InvStockEngineModule } from "../stock-engine/inv-stock-engine.module";

@Module({
  // F2. `InvCopilotService` injects `WarehouseScopeService`, which
  // `InvStockEngineModule` owns and exports. Without this import Nest cannot
  // construct it and the application fails to boot — and typecheck cannot see
  // that, because DI is resolved at runtime.
  imports: [
    AiModule,
    AiConfirmationModule,
    InvReplenishmentModule,
    InvVendorsModule,
    InvStockEngineModule,
  ],
  controllers: [InvAiController, InvAiExplainController, InvCopilotController],
  providers: [InvAiService, InvAiExplainService, InvCopilotService],
  exports: [InvAiService, InvAiExplainService, InvCopilotService],
})
export class InvAiModule {}
