import { Module } from "@nestjs/common";
import { InvAiController } from "./inv-ai.controller";
import { InvAiService } from "./inv-ai.service";
import { InvAiExplainController } from "./inv-ai-explain.controller";
import { InvAiExplainService } from "./inv-ai-explain.service";
import { InvCopilotController } from "./copilot/inv-copilot.controller";
import { InvCopilotService } from "./copilot/inv-copilot.service";
import { InvAiProposalService } from "./proposals/inv-ai-proposal.service";
import { InvAnomalyController } from "./anomalies/inv-anomaly.controller";
import { InvAnomalyQueueService } from "./anomalies/inv-anomaly-queue.service";
import { InvDemandRiskController } from "./demand-risk/inv-demand-risk.controller";
import { InvDemandRiskService } from "./demand-risk/inv-demand-risk.service";
import { InvReportBuilderController } from "./reports/inv-report-builder.controller";
import { InvReportBuilderService } from "./reports/inv-report-builder.service";
import { InvAiFeedbackController } from "./feedback/inv-ai-feedback.controller";
import { InvAiFeedbackService } from "./feedback/inv-ai-feedback.service";
import { AiModule } from "../../ai/core/ai.module";
import { AiConfirmationModule } from "../../ai/confirmation/ai-confirmation.module";
import { InvReplenishmentModule } from "../replenishment/inv-replenishment.module";
import { InvVendorsModule } from "../vendors/inv-vendors.module";
import { InvStockEngineModule } from "../stock-engine/inv-stock-engine.module";
import { InvReportsModule } from "../reports/inv-reports.module";

@Module({
  // F2. `InvCopilotService` injects `WarehouseScopeService`, which
  // `InvStockEngineModule` owns and exports. Without this import Nest cannot
  // construct it and the application fails to boot — and typecheck cannot see
  // that, because DI is resolved at runtime.
  //
  // F4. `InvAiProposalService` injects `PoBatchService` and
  // `ForecastPersistenceService`, both exported by `InvReplenishmentModule` for
  // the same reason: the AI proposal must be the buyer's proposal, not a second
  // derivation of it.
  //
  // F5. `InvReportsModule` is imported for the same reason and with the same
  // consequence: the natural-language report builder runs the reports module's
  // own services rather than a second copy of their queries, so that the AI path
  // and the ordinary report screen share one definition of which rows a person
  // may see. `InvReportsModule` exports both services; nothing in this module
  // reaches past them into the reports module's tables.
  //
  // F3. `InvReplenishmentModule` already exported `DemandBaselineService` and
  // `ForecastPersistenceService`; the demand-risk narrative reads both and
  // writes neither.
  imports: [
    AiModule,
    AiConfirmationModule,
    InvReplenishmentModule,
    InvVendorsModule,
    InvStockEngineModule,
    InvReportsModule,
  ],
  controllers: [
    InvAiController,
    InvAiExplainController,
    InvCopilotController,
    InvAnomalyController,
    InvDemandRiskController,
    InvReportBuilderController,
    InvAiFeedbackController,
  ],
  providers: [
    InvAiService,
    InvAiExplainService,
    InvCopilotService,
    InvAiProposalService,
    InvAnomalyQueueService,
    InvDemandRiskService,
    InvReportBuilderService,
    InvAiFeedbackService,
  ],
  exports: [
    InvAiService,
    InvAiExplainService,
    InvCopilotService,
    InvAiProposalService,
    InvAnomalyQueueService,
  ],
})
export class InvAiModule {}
