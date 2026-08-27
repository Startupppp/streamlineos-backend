import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { WorkflowRegistry } from "../../../common/workflow";
import type { StepContext, WorkflowRunContext } from "../../../common/workflow";
import { CallAnalysisWriterService } from "./call-analysis-writer.service";

/** One organisation's pass. Started by `CallAnalysisSweepService`, once per org. */
export const CALL_ANALYSIS_WORKFLOW = "crm.call-analysis.pass";

/**
 * A pass over one organisation's calls, as a durable run.
 *
 * On the workflow runtime rather than in the sweep's own loop, and the two steps
 * are the reason. `step.run` records its result and does not re-execute it on a
 * later attempt, so a pass that dies after erasing but before analysing resumes
 * at the analysis rather than repeating the erasure — and, far more expensively,
 * a pass that dies after analysing forty calls does not pay for those forty
 * again when it is retried.
 *
 * The order is also the argument. Erasure runs first because it is the half that
 * is a legal obligation: a pass that exhausts its budget, fails, or is retried
 * for a week has still honoured every withdrawal recorded since the last one.
 * Analysing first and erasing afterwards would leave a window — as long as the
 * model calls take — in which a withdrawn customer's call was freshly analysed.
 */
@Injectable()
export class CallAnalysisWorkflow implements OnModuleInit {
  private readonly logger = new Logger("CallAnalysis");

  constructor(
    private readonly registry: WorkflowRegistry,
    private readonly writer: CallAnalysisWriterService,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      name: CALL_ANALYSIS_WORKFLOW,
      maxAttempts: 3,
      handler: (step, context) => this.handle(step, context),
    });
  }

  private async handle(step: StepContext, context: WorkflowRunContext): Promise<void> {
    /**
     * `new Date()` inside the step rather than in the handler body.
     *
     * Code between steps runs again on every attempt, so a clock read out here
     * would be a different instant on each — and the consent expiry comparison
     * would then be made against whichever attempt happened to run. Inside a
     * step it is recorded with the result.
     */
    const erased = await step.run("erase-withdrawn", async () =>
      this.writer.reconcileConsent(context.organizationId, new Date()),
    );
    const erasedCount = erased.erased.length;

    /**
     * Flattened to plain numbers on the way out.
     *
     * A step's output is stored as JSON, and the pass's refusal tally is keyed
     * on a union — so spelling each count out here is both what makes it a legal
     * `JsonValue` and what makes the recorded step readable months later by
     * somebody asking why a quarter of an organisation's calls were never read.
     */
    const analysed = await step.run("analyse-due", async () => {
      const pass = await this.writer.analyseDue(context.organizationId, new Date());
      return {
        considered: pass.considered,
        analysed: pass.analysed,
        modelFailures: pass.modelFailures,
        refusedNoTranscript: pass.refused["no-transcript"],
        refusedConsentWithdrawn: pass.refused["consent-withdrawn"],
        refusedConsentNotGiven: pass.refused["consent-not-given"],
        refusedConsentExpired: pass.refused["consent-expired"],
      };
    });

    if (erasedCount > 0 || analysed.analysed > 0 || analysed.modelFailures > 0)
      this.logger.log(
        `Pass for org ${context.organizationId} — erased ${String(erasedCount)}, analysed ${String(analysed.analysed)} of ${String(analysed.considered)} considered, ${String(analysed.modelFailures)} model failures`,
      );
  }
}
