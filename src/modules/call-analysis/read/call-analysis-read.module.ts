import { Module } from "@nestjs/common";
import { AccessModule } from "../../access/access.module";
import { CallAnalysisController } from "./call-analysis.controller";
import { CallAnalysisReadService } from "./call-analysis-read.service";

/**
 * The surfaces, and deliberately not the analyser.
 *
 * `CallAnalysisAnalyserModule` is absent from `imports`, and its absence is the
 * feature. Nest resolves a provider only through the module graph, so a
 * controller in this module cannot inject `CallAnalysisWriterService` no matter
 * what it declares — the injection fails at boot rather than analysing a call.
 * `AiGatewayModule` is absent for the same reason one step further out: there is
 * no model client anywhere in this module's transitive closure, so no code
 * reachable from a request can spend a credit on a transcript.
 *
 * `read-cannot-analyse.spec.ts` walks this graph and the file imports on every
 * run. If somebody adds the import to make a "re-analyse" button work, the
 * suite goes red before the button does anything.
 */
@Module({
  imports: [AccessModule],
  controllers: [CallAnalysisController],
  providers: [CallAnalysisReadService],
  exports: [CallAnalysisReadService],
})
export class CallAnalysisReadModule {}
