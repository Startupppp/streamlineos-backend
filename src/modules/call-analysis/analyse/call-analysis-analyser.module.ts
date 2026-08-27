import { Module } from "@nestjs/common";
import { AiGatewayModule } from "../../ai/core/gateway/ai-gateway.module";
import { WorkflowModule } from "../../../common/workflow/workflow.module";
import { CallAnalysisSweepService } from "./call-analysis-sweep.service";
import { CallAnalysisWriterService } from "./call-analysis-writer.service";
import { CallAnalysisWorkflow } from "./call-analysis.workflow";

/**
 * Everything that can produce a call analysis, and nothing that shows one.
 *
 * The split from `CallAnalysisReadModule` is ticket 01's third criterion made
 * structural. This module is the only place `AiGatewayModule` is reachable from
 * in the call-analysis feature, and it exports one thing — the sweep, which the
 * cron surface calls. `CallAnalysisWriterService` is *not* exported, so no other
 * module can inject it however much it would like to; the read module does not
 * import this one; and `read-cannot-analyse.spec.ts` walks both graphs and fails
 * if either of those stops being true.
 *
 * The point is not that re-analysis on view is discouraged. It is that a
 * controller wanting to trigger one has nothing to call, and adding the
 * capability would mean adding an import that a test refuses.
 */
@Module({
  imports: [AiGatewayModule, WorkflowModule],
  providers: [CallAnalysisWriterService, CallAnalysisWorkflow, CallAnalysisSweepService],
  exports: [CallAnalysisSweepService],
})
export class CallAnalysisAnalyserModule {}
