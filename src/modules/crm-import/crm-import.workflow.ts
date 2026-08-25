import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { WorkflowRegistry } from "../../common/workflow";
import type { StepContext, WorkflowRunContext } from "../../common/workflow";
import { CrmImportService } from "./crm-import.service";

export const IMPORT_WORKFLOW = "crm.import-commit";

/**
 * Committing an import, durably.
 *
 * A large file is minutes of writes, and a deploy in the middle of one must not
 * leave half a customer list imported with no record of where it stopped. The
 * runtime gives each step its own tenant transaction that commits together with
 * the memo that the step ran, so a resumed run walks past what is already done.
 *
 * The rows themselves carry the finer-grained resumption: `commit` only reads
 * rows with no `committed_at`, so even a crash inside the step re-reads only
 * what is genuinely outstanding rather than starting the file again.
 *
 * ── Nothing starts this run. ──────────────────────────────────────────────
 *
 * Registered and unreachable: the shipped path is `POST /imports/:id/commit`,
 * which calls `commit` inline. Said plainly here because a registration reads
 * like a wiring, and the next person to look at a slow import should not have
 * to grep for the enqueue that is missing.
 *
 * Connecting it is more than a `startRun`, and the missing part is this file's:
 * the whole commit is ONE step, so it is one transaction, and a step whose
 * transaction times out rolls back every `committed_at` it just wrote. The
 * per-row resumption above only pays off across attempts that COMMITTED, so as
 * written a retry would redo the file from the start and hit the same ceiling
 * three times. Durability here means committing the file in chunks — a step per
 * batch of rows, named deterministically so a resumed run skips the batches
 * already memoised — plus an accepted-and-poll contract at the controller, since
 * the caller can no longer be handed a result. That is a ticket, not a line.
 *
 * Until then `commit` carries the file inline and returns `complete: false` with
 * the rows outstanding when a request runs out of budget, so a large import
 * finishes across several calls instead of dying in one.
 */
@Injectable()
export class CrmImportWorkflow implements OnModuleInit {
  private readonly logger = new Logger("CrmImport");

  constructor(
    private readonly registry: WorkflowRegistry,
    private readonly imports: CrmImportService,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      name: IMPORT_WORKFLOW,
      maxAttempts: 3,
      handler: (step, context) => this.handle(step, context),
    });
  }

  private async handle(step: StepContext, context: WorkflowRunContext): Promise<void> {
    const crmImportId = String(context.input.crmImportId ?? "");
    if (!crmImportId) throw new Error("import: run started without a crmImportId");

    await step.run("commit-rows", async () => {
      const result = await this.imports.commit(context.organizationId, crmImportId);
      this.logger.log(
        `import ${crmImportId}: ${result.created} created, ${result.updated} updated, ${result.failed} failed`,
      );
      return result;
    });
  }
}
