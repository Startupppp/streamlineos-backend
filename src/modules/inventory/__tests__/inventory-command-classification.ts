/**
 * T17 — what a retry of each inventory command does.
 *
 * PRD §12.4 says all commands are idempotent. Nothing established "all": the
 * only coverage assertion was `MUST_TAKE_A_KEY`, eighteen handler names typed
 * out by hand, beside a general rule that could bite only on a handler which
 * already asked for a key. 159 of the 214 mutating routes were examined by
 * neither.
 *
 * So the population is derived (`inventory-mutating-routes.ts`) and every route
 * that does not take a client key has to be classified here, with the reason.
 * The direction matters: this is an exemption list, not a coverage list. A new
 * mutating controller lands *unclassified* and fails, the way `NO_DATA_ROUTES`
 * and `CANNOT_INVALIDATE` work elsewhere in this repo — where UNPROVEN is not a
 * resting state.
 *
 * `DUPLICATES_ON_RETRY` is the honest result of doing the classification: forty
 * routes where a retry raises a second document, and the PRD's "all" is not yet
 * true. They are findings on the record, not exemptions. Adding keys to them is
 * a separate change with its own retry test each.
 */

export type CommandClass =
  | "NO_PERSISTENCE"
  | "CONVERGING"
  | "REPEATABLE_OPERATION"
  | "CLAIMS_ITS_OWN_KEY"
  | "DUPLICATES_ON_RETRY";

/** Why each class is a sound answer to "what does a retry do". */
export const COMMAND_CLASS_RATIONALE: Readonly<Record<CommandClass, string>> = {
  NO_PERSISTENCE:
    "Writes no business state. It is a POST only because its input does not fit in a query string. There is no effect to replay, so a key would be a token the client is made to mint and the server cannot use — and while the first lease was live it would turn every re-run into a 409. This is D4's argument, and `recalls/simulate` is its worked example.",
  CONVERGING:
    "A retry converges on the state the first run left. The command applies supplied values, or a terminal status, to a row named in the URL; it creates no new business document, so there is nothing for a second run to duplicate.",
  REPEATABLE_OPERATION:
    "Re-running is the operation, not a duplicate of it: a sync, a re-delivery, a refresh, a sweep, a cron tick. The work is defined against current state rather than against a document the call creates, so the second run does the same work over whatever is still outstanding.",
  CLAIMS_ITS_OWN_KEY:
    "The command already claims an idempotency key, obtained without the header — computed from the target's own identity, or carried per operation in the payload. Demanding a client header key here would be weaker rather than stronger, because a client that minted a fresh key on retry would defeat a claim the server makes correctly.",
  DUPLICATES_ON_RETRY:
    "A FINDING, NOT AN EXEMPTION. A retry after a timed-out first attempt raises a second business document. PRD §12.4 says all commands are idempotent; these are the routes where that is not yet true. Fixing one is its own change with its own retry test, so they are recorded here rather than quietly left uncounted.",
};

export interface RouteClassification {
  /** `<file>::<handler>`, matching `MutatingRoute.id`. */
  route: string;
  commandClass: CommandClass;
  why: string;
}

/**
 * Every mutating inventory route that does not take `@IdempotencyKey()`.
 *
 * A route that takes the key needs no entry: taking it is the classification,
 * and it is read off the source rather than off a list. Everything else is
 * here, or the check fails.
 *
 * Confidence is not uniform, and the check cannot make it so. The
 * `NO_PERSISTENCE` entries were each verified by reading the service method
 * they name. The `CLAIMS_ITS_OWN_KEY` entries quote the key the command builds.
 * The `CONVERGING` entries for updates and deletes rest on the verb and on
 * there being no create in the handler's path; the ones for status transitions
 * rest on the transition being a transition. That last group is the softest
 * part of this table, and it is the part a future retry test should harden.
 */
export const COMMAND_CLASSIFICATION: ReadonlyArray<RouteClassification> = [
  { route: "ai/anomalies/inv-anomaly.controller.ts::review", commandClass: "CONVERGING", why: "Applies the supplied fields to the row named in the URL. Re-sending the same body leaves the same row, and nothing new is created for a retry to duplicate." },
  { route: "ai/copilot/inv-copilot.controller.ts::ask", commandClass: "NO_PERSISTENCE", why: "Answers a question about stock from the read model. InvCopilotService.ask makes no insert, update or delete call." },
  { route: "ai/demand-risk/inv-demand-risk.controller.ts::explain", commandClass: "NO_PERSISTENCE", why: "Explains a demand-risk score. InvDemandRiskService.explain makes no insert, update or delete call." },
  { route: "ai/feedback/inv-ai-feedback.controller.ts::submit", commandClass: "DUPLICATES_ON_RETRY", why: "A retry after a timed-out first attempt raises a second feedback row against the same suggestion." },
  { route: "ai/inv-ai-explain.controller.ts::confirmReorderProposal", commandClass: "CONVERGING", why: "A status transition on the row named in the URL. The second run either finds the row already in the target state or is refused by the command's own status precondition, so no second document appears." },
  { route: "ai/inv-ai-explain.controller.ts::explainInsight", commandClass: "NO_PERSISTENCE", why: "Narrates an insight that already exists. InvAiExplainService.explainInsight makes no insert, update or delete call." },
  { route: "ai/inv-ai-explain.controller.ts::getReorderProposal", commandClass: "CLAIMS_ITS_OWN_KEY", why: "Claims `ai-reorder:${orgId}:${proposalId}` — derived from the proposal it is about, so two calls for the same proposal collapse whether or not the client noticed it retried." },
  { route: "ai/inv-ai-explain.controller.ts::narrateOpsBrief", commandClass: "NO_PERSISTENCE", why: "Renders the operations brief as prose. InvAiExplainService.narrateOpsBrief makes no insert, update or delete call." },
  { route: "ai/inv-ai.controller.ts::generateInsights", commandClass: "DUPLICATES_ON_RETRY", why: "A retry after a timed-out first attempt raises a second run of insight generation for the same window." },
  { route: "ai/inv-ai.controller.ts::updateInsightStatus", commandClass: "CONVERGING", why: "Applies the supplied fields to the row named in the URL. Re-sending the same body leaves the same row, and nothing new is created for a retry to duplicate." },
  { route: "ai/reports/inv-report-builder.controller.ts::ask", commandClass: "NO_PERSISTENCE", why: "Turns a question into a report projection. InvReportBuilderService.ask makes no insert, update or delete call." },
  { route: "ai/reports/inv-report-builder.controller.ts::export", commandClass: "NO_PERSISTENCE", why: "Renders an already-computed report to a file body in the response. InvReportBuilderService.export makes no insert, update or delete call." },
  { route: "audit-export/audit-export.controller.ts::createJob", commandClass: "DUPLICATES_ON_RETRY", why: "A retry after a timed-out first attempt raises a second audit-export job." },
  { route: "barcode/inv-barcode.controller.ts::scan", commandClass: "NO_PERSISTENCE", why: "Resolves a barcode to what it identifies. The scan that is *recorded* is captureScan, which is a separate keyed route; InvBarcodeService.scan makes no insert, update or delete call." },
  { route: "channels/channel-snapshot.controller.ts::accept", commandClass: "CLAIMS_ITS_OWN_KEY", why: "Claims `channel-snapshot-diff:${diff.id}` — the difference's own id. A client key would be weaker here, not stronger: a retry that minted a fresh key would defeat a claim the server already makes correctly." },
  { route: "channels/channel-snapshot.controller.ts::dismiss", commandClass: "CONVERGING", why: "A status transition on the row named in the URL. The second run either finds the row already in the target state or is refused by the command's own status precondition, so no second document appears." },
  { route: "channels/channel-snapshot.controller.ts::runPost", commandClass: "REPEATABLE_OPERATION", why: "A cron entry point, not a user command. No browser or device ever retries it, and there is no client to mint a key." },
  { route: "channels/channel-webhook.controller.ts::inbound", commandClass: "REPEATABLE_OPERATION", why: "An inbound provider webhook. The provider controls its own retries and cannot be asked for our Idempotency-Key header, so replay safety here rests on the provider's event id rather than on a header this route could demand." },
  { route: "channels/channels.controller.ts::create", commandClass: "DUPLICATES_ON_RETRY", why: "A retry after a timed-out first attempt raises a second sales channel." },
  { route: "channels/channels.controller.ts::retryPublications", commandClass: "REPEATABLE_OPERATION", why: "Re-drives publications that failed. A second retry re-drives whatever is still failing and nothing else." },
  { route: "channels/channels.controller.ts::syncStock", commandClass: "REPEATABLE_OPERATION", why: "Pushes current availability to the channel. Running it again pushes the same numbers; that is what the button is for." },
  { route: "channels/channels.controller.ts::update", commandClass: "CONVERGING", why: "Applies the supplied fields to the row named in the URL. Re-sending the same body leaves the same row, and nothing new is created for a retry to duplicate." },
  { route: "channels/quick-commerce/quick-commerce.controller.ts::uploadPayout", commandClass: "DUPLICATES_ON_RETRY", why: "A retry after a timed-out first attempt raises a second payout upload for the same statement." },
  { route: "channels/tpl.controller.ts::createConnection", commandClass: "DUPLICATES_ON_RETRY", why: "A retry after a timed-out first attempt raises a second 3PL connection." },
  { route: "channels/tpl.controller.ts::syncConnection", commandClass: "REPEATABLE_OPERATION", why: "Pulls the 3PL's current state. Re-running re-reads; it raises no document of its own." },
  { route: "channels/tpl.controller.ts::updateConnection", commandClass: "CONVERGING", why: "Applies the supplied fields to the row named in the URL. Re-sending the same body leaves the same row, and nothing new is created for a retry to duplicate." },
  { route: "counts/inv-cycle-counts.controller.ts::cancel", commandClass: "CONVERGING", why: "A status transition on the row named in the URL. The second run either finds the row already in the target state or is refused by the command's own status precondition, so no second document appears." },
  { route: "counts/inv-cycle-counts.controller.ts::create", commandClass: "DUPLICATES_ON_RETRY", why: "A retry after a timed-out first attempt raises a second cycle count over the same locations." },
  { route: "counts/inv-cycle-counts.controller.ts::review", commandClass: "CONVERGING", why: "A status transition on the row named in the URL. The second run either finds the row already in the target state or is refused by the command's own status precondition, so no second document appears." },
  { route: "counts/inv-cycle-counts.controller.ts::start", commandClass: "CONVERGING", why: "A status transition on the row named in the URL. The second run either finds the row already in the target state or is refused by the command's own status precondition, so no second document appears." },
  { route: "counts/inv-cycle-counts.controller.ts::updateLines", commandClass: "CONVERGING", why: "Applies the supplied fields to the row named in the URL. Re-sending the same body leaves the same row, and nothing new is created for a retry to duplicate." },
  { route: "counts/inv-physical-audits.controller.ts::cancel", commandClass: "CONVERGING", why: "A status transition on the row named in the URL. The second run either finds the row already in the target state or is refused by the command's own status precondition, so no second document appears." },
  { route: "counts/inv-physical-audits.controller.ts::create", commandClass: "DUPLICATES_ON_RETRY", why: "A retry after a timed-out first attempt raises a second physical audit." },
  { route: "counts/inv-physical-audits.controller.ts::review", commandClass: "CONVERGING", why: "A status transition on the row named in the URL. The second run either finds the row already in the target state or is refused by the command's own status precondition, so no second document appears." },
  { route: "counts/inv-physical-audits.controller.ts::start", commandClass: "CONVERGING", why: "A status transition on the row named in the URL. The second run either finds the row already in the target state or is refused by the command's own status precondition, so no second document appears." },
  { route: "counts/inv-physical-audits.controller.ts::updateLines", commandClass: "CONVERGING", why: "Applies the supplied fields to the row named in the URL. Re-sending the same body leaves the same row, and nothing new is created for a retry to duplicate." },
  { route: "dock/dock.controller.ts::book", commandClass: "DUPLICATES_ON_RETRY", why: "A retry after a timed-out first attempt raises a second dock appointment in the same slot." },
  { route: "dock/dock.controller.ts::createDoor", commandClass: "DUPLICATES_ON_RETRY", why: "A retry after a timed-out first attempt raises a second dock door." },
  { route: "dock/dock.controller.ts::setStatus", commandClass: "CONVERGING", why: "Applies the supplied fields to the row named in the URL. Re-sending the same body leaves the same row, and nothing new is created for a retry to duplicate." },
  { route: "handling-units/handling-units.controller.ts::nest", commandClass: "CONVERGING", why: "Applies the supplied fields to the row named in the URL. Re-sending the same body leaves the same row, and nothing new is created for a retry to duplicate." },
  { route: "import-export/export.controller.ts::createJob", commandClass: "DUPLICATES_ON_RETRY", why: "A retry after a timed-out first attempt raises a second export job." },
  { route: "import-export/import.controller.ts::cancelStaged", commandClass: "CONVERGING", why: "A status transition on the row named in the URL. The second run either finds the row already in the target state or is refused by the command's own status precondition, so no second document appears." },
  { route: "import-export/import.controller.ts::createJob", commandClass: "DUPLICATES_ON_RETRY", why: "A retry after a timed-out first attempt raises a second import job over the same upload." },
  { route: "import-export/import.controller.ts::preview", commandClass: "NO_PERSISTENCE", why: "Parses an upload and reports what it would do. ImportService.previewImport makes no insert, update or delete call." },
  { route: "import-export/import.controller.ts::processChunk", commandClass: "REPEATABLE_OPERATION", why: "Processes the next chunk of an already-staged job. Progress is held on the job, so a re-issued chunk resumes rather than re-applies." },
  { route: "import-export/import.controller.ts::stageRows", commandClass: "DUPLICATES_ON_RETRY", why: "A retry after a timed-out first attempt raises a second copy of the staged rows." },
  { route: "kitting/kit.controller.ts::setBom", commandClass: "CONVERGING", why: "Replaces the whole bill of materials: the components are deleted and re-inserted from the supplied body, so the second run leaves exactly what the first did." },
  { route: "landed-cost/landed-cost.controller.ts::addCharge", commandClass: "DUPLICATES_ON_RETRY", why: "A retry after a timed-out first attempt raises a second charge line on the voucher, which changes the valuation it applies." },
  { route: "landed-cost/landed-cost.controller.ts::remove", commandClass: "CONVERGING", why: "Removing a row that is already gone is a no-op or a 404. There is no second document a retry could raise." },
  { route: "notifications/inv-expiry-sweep.controller.ts::run", commandClass: "REPEATABLE_OPERATION", why: "A maintenance sweep over lots nearing expiry. Re-running re-evaluates the same set." },
  { route: "picking/pick-exception.controller.ts::assign", commandClass: "CONVERGING", why: "A status transition on the row named in the URL. The second run either finds the row already in the target state or is refused by the command's own status precondition, so no second document appears." },
  { route: "picking/pick-exception.controller.ts::resolve", commandClass: "CONVERGING", why: "A status transition on the row named in the URL. The second run either finds the row already in the target state or is refused by the command's own status precondition, so no second document appears." },
  { route: "picking/pick-wave.controller.ts::abandonWave", commandClass: "CONVERGING", why: "A status transition on the row named in the URL. The second run either finds the row already in the target state or is refused by the command's own status precondition, so no second document appears." },
  { route: "picking/pick-wave.controller.ts::claimWave", commandClass: "CONVERGING", why: "A status transition on the row named in the URL. The second run either finds the row already in the target state or is refused by the command's own status precondition, so no second document appears." },
  { route: "picking/pick-wave.controller.ts::createWave", commandClass: "DUPLICATES_ON_RETRY", why: "A retry after a timed-out first attempt raises a second pick wave over the same orders." },
  { route: "picking/pick-wave.controller.ts::joinWave", commandClass: "CONVERGING", why: "A status transition on the row named in the URL. The second run either finds the row already in the target state or is refused by the command's own status precondition, so no second document appears." },
  { route: "picking/pick-wave.controller.ts::proposeJoin", commandClass: "NO_PERSISTENCE", why: "Proposes which wave a picker could join. PickWaveService.proposeWaveJoin makes no insert, update or delete call; joinWave is the command that acts on the answer." },
  { route: "picking/pick-wave.controller.ts::reassignWave", commandClass: "CONVERGING", why: "A status transition on the row named in the URL. The second run either finds the row already in the target state or is refused by the command's own status precondition, so no second document appears." },
  { route: "products/inv-products.controller.ts::archive", commandClass: "CONVERGING", why: "A status transition on the row named in the URL. The second run either finds the row already in the target state or is refused by the command's own status precondition, so no second document appears." },
  { route: "products/inv-products.controller.ts::create", commandClass: "DUPLICATES_ON_RETRY", why: "A retry after a timed-out first attempt raises a second product." },
  { route: "products/inv-products.controller.ts::createCategory", commandClass: "DUPLICATES_ON_RETRY", why: "A retry after a timed-out first attempt raises a second category." },
  { route: "products/inv-products.controller.ts::createUom", commandClass: "DUPLICATES_ON_RETRY", why: "A retry after a timed-out first attempt raises a second unit of measure." },
  { route: "products/inv-products.controller.ts::createVariant", commandClass: "DUPLICATES_ON_RETRY", why: "A retry after a timed-out first attempt raises a second variant." },
  { route: "products/inv-products.controller.ts::delete", commandClass: "CONVERGING", why: "Removing a row that is already gone is a no-op or a 404. There is no second document a retry could raise." },
  { route: "products/inv-products.controller.ts::restore", commandClass: "CONVERGING", why: "A status transition on the row named in the URL. The second run either finds the row already in the target state or is refused by the command's own status precondition, so no second document appears." },
  { route: "products/inv-products.controller.ts::update", commandClass: "CONVERGING", why: "Applies the supplied fields to the row named in the URL. Re-sending the same body leaves the same row, and nothing new is created for a retry to duplicate." },
  { route: "products/inv-products.controller.ts::updateCategory", commandClass: "CONVERGING", why: "Applies the supplied fields to the row named in the URL. Re-sending the same body leaves the same row, and nothing new is created for a retry to duplicate." },
  { route: "products/inv-products.controller.ts::updateUom", commandClass: "CONVERGING", why: "Applies the supplied fields to the row named in the URL. Re-sending the same body leaves the same row, and nothing new is created for a retry to duplicate." },
  { route: "products/inv-products.controller.ts::updateVariant", commandClass: "CONVERGING", why: "Applies the supplied fields to the row named in the URL. Re-sending the same body leaves the same row, and nothing new is created for a retry to duplicate." },
  { route: "projects/inv-projects.controller.ts::addRequirement", commandClass: "DUPLICATES_ON_RETRY", why: "A retry after a timed-out first attempt raises a second requirement line." },
  { route: "projects/inv-projects.controller.ts::archive", commandClass: "CONVERGING", why: "Removing a row that is already gone is a no-op or a 404. There is no second document a retry could raise." },
  { route: "projects/inv-projects.controller.ts::create", commandClass: "DUPLICATES_ON_RETRY", why: "A retry after a timed-out first attempt raises a second project." },
  { route: "projects/inv-projects.controller.ts::release", commandClass: "CONVERGING", why: "A status transition on the row named in the URL. The second run either finds the row already in the target state or is refused by the command's own status precondition, so no second document appears." },
  { route: "projects/inv-projects.controller.ts::reserve", commandClass: "CONVERGING", why: "A status transition on the row named in the URL. The second run either finds the row already in the target state or is refused by the command's own status precondition, so no second document appears." },
  { route: "projects/inv-projects.controller.ts::update", commandClass: "CONVERGING", why: "Applies the supplied fields to the row named in the URL. Re-sending the same body leaves the same row, and nothing new is created for a retry to duplicate." },
  { route: "projects/inv-projects.controller.ts::updateRequirement", commandClass: "CONVERGING", why: "Applies the supplied fields to the row named in the URL. Re-sending the same body leaves the same row, and nothing new is created for a retry to duplicate." },
  { route: "purchase-orders/grn.controller.ts::cancel", commandClass: "CONVERGING", why: "A status transition on the row named in the URL. The second run either finds the row already in the target state or is refused by the command's own status precondition, so no second document appears." },
  { route: "purchase-orders/grn.controller.ts::startCounting", commandClass: "CONVERGING", why: "A status transition on the row named in the URL. The second run either finds the row already in the target state or is refused by the command's own status precondition, so no second document appears." },
  { route: "purchase-orders/grn.controller.ts::submitForQualityReview", commandClass: "CONVERGING", why: "A status transition on the row named in the URL. The second run either finds the row already in the target state or is refused by the command's own status precondition, so no second document appears." },
  { route: "purchase-orders/grn.controller.ts::updateDraft", commandClass: "CONVERGING", why: "Applies the supplied fields to the row named in the URL. Re-sending the same body leaves the same row, and nothing new is created for a retry to duplicate." },
  { route: "purchase-orders/inv-purchase-orders.controller.ts::approve", commandClass: "CONVERGING", why: "A status transition on the row named in the URL. The second run either finds the row already in the target state or is refused by the command's own status precondition, so no second document appears." },
  { route: "purchase-orders/inv-purchase-orders.controller.ts::cancel", commandClass: "CONVERGING", why: "A status transition on the row named in the URL. The second run either finds the row already in the target state or is refused by the command's own status precondition, so no second document appears." },
  { route: "purchase-orders/inv-purchase-orders.controller.ts::close", commandClass: "CONVERGING", why: "A status transition on the row named in the URL. The second run either finds the row already in the target state or is refused by the command's own status precondition, so no second document appears." },
  { route: "purchase-orders/inv-purchase-orders.controller.ts::create", commandClass: "DUPLICATES_ON_RETRY", why: "A retry after a timed-out first attempt raises a second purchase order to the same vendor." },
  { route: "purchase-orders/inv-purchase-orders.controller.ts::send", commandClass: "CONVERGING", why: "A status transition on the row named in the URL. The second run either finds the row already in the target state or is refused by the command's own status precondition, so no second document appears." },
  { route: "purchase-orders/inv-purchase-orders.controller.ts::update", commandClass: "CONVERGING", why: "Applies the supplied fields to the row named in the URL. Re-sending the same body leaves the same row, and nothing new is created for a retry to duplicate." },
  { route: "putaway/putaway-task.controller.ts::abandonTask", commandClass: "CONVERGING", why: "A status transition on the row named in the URL. The second run either finds the row already in the target state or is refused by the command's own status precondition, so no second document appears." },
  { route: "putaway/putaway-task.controller.ts::cancelTask", commandClass: "CONVERGING", why: "A status transition on the row named in the URL. The second run either finds the row already in the target state or is refused by the command's own status precondition, so no second document appears." },
  { route: "putaway/putaway-task.controller.ts::claimTask", commandClass: "CONVERGING", why: "A status transition on the row named in the URL. The second run either finds the row already in the target state or is refused by the command's own status precondition, so no second document appears." },
  { route: "putaway/putaway-task.controller.ts::createTask", commandClass: "DUPLICATES_ON_RETRY", why: "A retry after a timed-out first attempt raises a second putaway task for the same receipt." },
  { route: "quality/inspection-plans.controller.ts::activateVersion", commandClass: "CONVERGING", why: "A status transition on the row named in the URL. The second run either finds the row already in the target state or is refused by the command's own status precondition, so no second document appears." },
  { route: "quality/inspection-plans.controller.ts::addVersion", commandClass: "DUPLICATES_ON_RETRY", why: "A retry after a timed-out first attempt raises a second plan version." },
  { route: "quality/inspection-plans.controller.ts::create", commandClass: "DUPLICATES_ON_RETRY", why: "A retry after a timed-out first attempt raises a second inspection plan." },
  { route: "quality/inspection-plans.controller.ts::remove", commandClass: "CONVERGING", why: "Removing a row that is already gone is a no-op or a 404. There is no second document a retry could raise." },
  { route: "quality/inspection-plans.controller.ts::update", commandClass: "CONVERGING", why: "Applies the supplied fields to the row named in the URL. Re-sending the same body leaves the same row, and nothing new is created for a retry to duplicate." },
  { route: "quality/inspections.controller.ts::correct", commandClass: "CONVERGING", why: "Raises the correction inspection, and a second attempt is refused with \"This inspection has already been corrected\" rather than raising another." },
  { route: "quality/inspections.controller.ts::create", commandClass: "DUPLICATES_ON_RETRY", why: "A retry after a timed-out first attempt raises a second inspection." },
  { route: "quality/inspections.controller.ts::fail", commandClass: "CONVERGING", why: "A status transition on the row named in the URL. The second run either finds the row already in the target state or is refused by the command's own status precondition, so no second document appears." },
  { route: "quality/inspections.controller.ts::start", commandClass: "CONVERGING", why: "A status transition on the row named in the URL. The second run either finds the row already in the target state or is refused by the command's own status precondition, so no second document appears." },
  { route: "quality/recalls.controller.ts::simulate", commandClass: "NO_PERSISTENCE", why: "D4's worked example, already asserted separately below. A recall selection does not fit in a query string, so the blast-radius calculation is a POST; RecallSimulationService.simulate makes no insert, update or delete call." },
  { route: "quality/recalls.controller.ts::update", commandClass: "CONVERGING", why: "Applies the supplied fields to the row named in the URL. Re-sending the same body leaves the same row, and nothing new is created for a retry to duplicate." },
  { route: "reconciliation/inv-reconciliation.controller.ts::repair", commandClass: "CONVERGING", why: "Writes the ledger-derived value over the projection. A second repair recomputes the same value and reports rowsChanged 0." },
  { route: "replenishment/inv-forecasting.controller.ts::generateVersion", commandClass: "REPEATABLE_OPERATION", why: "Recomputes one variant's forecast version from current demand. Re-running recomputes it." },
  { route: "replenishment/inv-forecasting.controller.ts::refreshVersions", commandClass: "REPEATABLE_OPERATION", why: "Recomputes forecast versions from current demand. The same inputs produce the same version." },
  { route: "replenishment/inv-forecasting.controller.ts::simulate", commandClass: "NO_PERSISTENCE", why: "Runs the replenishment simulator against a variant. ReplenishmentSimulatorService.simulate makes no insert, update or delete call." },
  { route: "replenishment/inv-po-batches.controller.ts::preview", commandClass: "NO_PERSISTENCE", why: "Shows the purchase orders a batch would raise. PoBatchService.preview makes no insert, update or delete call; PoBatchService.create is the keyed command." },
  { route: "replenishment/inv-replenishment.controller.ts::createRule", commandClass: "DUPLICATES_ON_RETRY", why: "A retry after a timed-out first attempt raises a second replenishment rule for the same variant." },
  { route: "replenishment/inv-replenishment.controller.ts::deleteRule", commandClass: "CONVERGING", why: "Removing a row that is already gone is a no-op or a 404. There is no second document a retry could raise." },
  { route: "replenishment/inv-replenishment.controller.ts::updateRule", commandClass: "CONVERGING", why: "Applies the supplied fields to the row named in the URL. Re-sending the same body leaves the same row, and nothing new is created for a retry to duplicate." },
  { route: "returns/customer-returns.controller.ts::approve", commandClass: "CONVERGING", why: "A status transition on the row named in the URL. The second run either finds the row already in the target state or is refused by the command's own status precondition, so no second document appears." },
  { route: "returns/customer-returns.controller.ts::cancel", commandClass: "CONVERGING", why: "A status transition on the row named in the URL. The second run either finds the row already in the target state or is refused by the command's own status precondition, so no second document appears." },
  { route: "returns/customer-returns.controller.ts::create", commandClass: "DUPLICATES_ON_RETRY", why: "A retry after a timed-out first attempt raises a second customer return." },
  { route: "returns/customer-returns.controller.ts::inspectLine", commandClass: "CONVERGING", why: "A status transition on the row named in the URL. The second run either finds the row already in the target state or is refused by the command's own status precondition, so no second document appears." },
  { route: "returns/vendor-returns.controller.ts::approve", commandClass: "CONVERGING", why: "A status transition on the row named in the URL. The second run either finds the row already in the target state or is refused by the command's own status precondition, so no second document appears." },
  { route: "returns/vendor-returns.controller.ts::cancel", commandClass: "CONVERGING", why: "A status transition on the row named in the URL. The second run either finds the row already in the target state or is refused by the command's own status precondition, so no second document appears." },
  { route: "returns/vendor-returns.controller.ts::create", commandClass: "DUPLICATES_ON_RETRY", why: "A retry after a timed-out first attempt raises a second vendor return." },
  { route: "sales-orders/inv-sales-orders.controller.ts::cancel", commandClass: "CONVERGING", why: "A status transition on the row named in the URL. The second run either finds the row already in the target state or is refused by the command's own status precondition, so no second document appears." },
  { route: "sales-orders/inv-sales-orders.controller.ts::create", commandClass: "DUPLICATES_ON_RETRY", why: "A retry after a timed-out first attempt raises a second sales order." },
  { route: "sales-orders/inv-sales-orders.controller.ts::invoice", commandClass: "DUPLICATES_ON_RETRY", why: "A retry after a timed-out first attempt raises a second invoice against the same order." },
  { route: "sales-orders/inv-sales-orders.controller.ts::update", commandClass: "CONVERGING", why: "Applies the supplied fields to the row named in the URL. Re-sending the same body leaves the same row, and nothing new is created for a retry to duplicate." },
  { route: "settings/settings.controller.ts::expireReservations", commandClass: "REPEATABLE_OPERATION", why: "Sweeps reservations already past their expiry. A second sweep finds none left to expire." },
  { route: "settings/settings.controller.ts::putShelfLifeRule", commandClass: "CONVERGING", why: "Applies the supplied fields to the row named in the URL. Re-sending the same body leaves the same row, and nothing new is created for a retry to duplicate." },
  { route: "settings/settings.controller.ts::updateNumberSequence", commandClass: "CONVERGING", why: "Applies the supplied fields to the row named in the URL. Re-sending the same body leaves the same row, and nothing new is created for a retry to duplicate." },
  { route: "settings/settings.controller.ts::updateSettings", commandClass: "CONVERGING", why: "Applies the supplied fields to the row named in the URL. Re-sending the same body leaves the same row, and nothing new is created for a retry to duplicate." },
  { route: "shipments/carrier-status.controller.ts::recordStatus", commandClass: "CLAIMS_ITS_OWN_KEY", why: "Deduplicated on the carrier's own event id, and monotonic — an event that would move the shipment backwards is recorded and ignored. Carriers resend; the natural key is the right one." },
  { route: "shipments/carrier-status.controller.ts::refreshTracking", commandClass: "REPEATABLE_OPERATION", why: "Re-polls the carrier for the shipment's current status. The events it stores are deduplicated on the carrier's own event id." },
  { route: "shipments/carriers.controller.ts::create", commandClass: "DUPLICATES_ON_RETRY", why: "A retry after a timed-out first attempt raises a second carrier." },
  { route: "shipments/carriers.controller.ts::update", commandClass: "CONVERGING", why: "Applies the supplied fields to the row named in the URL. Re-sending the same body leaves the same row, and nothing new is created for a retry to duplicate." },
  { route: "shipments/cartonization.controller.ts::suggest", commandClass: "NO_PERSISTENCE", why: "Suggests a carton mix for a set of lines. CartonizationService.suggest makes no insert, update or delete call." },
  { route: "shipments/loads.controller.ts::cancel", commandClass: "CONVERGING", why: "A status transition on the row named in the URL. The second run either finds the row already in the target state or is refused by the command's own status precondition, so no second document appears." },
  { route: "shipments/loads.controller.ts::close", commandClass: "CONVERGING", why: "A status transition on the row named in the URL. The second run either finds the row already in the target state or is refused by the command's own status precondition, so no second document appears." },
  { route: "shipments/loads.controller.ts::create", commandClass: "DUPLICATES_ON_RETRY", why: "A retry after a timed-out first attempt raises a second load." },
  { route: "shipments/packages.controller.ts::close", commandClass: "CONVERGING", why: "A status transition on the row named in the URL. The second run either finds the row already in the target state or is refused by the command's own status precondition, so no second document appears." },
  { route: "shipments/packages.controller.ts::create", commandClass: "DUPLICATES_ON_RETRY", why: "A retry after a timed-out first attempt raises a second package." },
  { route: "shipments/packages.controller.ts::reopen", commandClass: "CONVERGING", why: "A status transition on the row named in the URL. The second run either finds the row already in the target state or is refused by the command's own status precondition, so no second document appears." },
  { route: "shipments/packages.controller.ts::updateLines", commandClass: "CONVERGING", why: "Applies the supplied fields to the row named in the URL. Re-sending the same body leaves the same row, and nothing new is created for a retry to duplicate." },
  { route: "shipments/shipments.controller.ts::cancel", commandClass: "CONVERGING", why: "A status transition on the row named in the URL. The second run either finds the row already in the target state or is refused by the command's own status precondition, so no second document appears." },
  { route: "shipments/shipments.controller.ts::create", commandClass: "DUPLICATES_ON_RETRY", why: "A retry after a timed-out first attempt raises a second shipment." },
  { route: "shipments/shipments.controller.ts::update", commandClass: "CONVERGING", why: "Applies the supplied fields to the row named in the URL. Re-sending the same body leaves the same row, and nothing new is created for a retry to duplicate." },
  { route: "slotting/slotting.controller.ts::createRule", commandClass: "DUPLICATES_ON_RETRY", why: "A retry after a timed-out first attempt raises a second slotting rule." },
  { route: "slotting/slotting.controller.ts::dismiss", commandClass: "CONVERGING", why: "A status transition on the row named in the URL. The second run either finds the row already in the target state or is refused by the command's own status precondition, so no second document appears." },
  { route: "slotting/slotting.controller.ts::runPost", commandClass: "REPEATABLE_OPERATION", why: "A cron entry point, not a user command. No browser or device ever retries it, and there is no client to mint a key." },
  { route: "slotting/slotting.controller.ts::setRuleActive", commandClass: "CONVERGING", why: "Applies the supplied fields to the row named in the URL. Re-sending the same body leaves the same row, and nothing new is created for a retry to duplicate." },
  { route: "stock/inv-stock-adjustments.controller.ts::cancelAdjustment", commandClass: "CONVERGING", why: "A status transition on the row named in the URL. The second run either finds the row already in the target state or is refused by the command's own status precondition, so no second document appears." },
  { route: "sync/sync-batch.controller.ts::applyBatch", commandClass: "CLAIMS_ITS_OWN_KEY", why: "The RF device's own operation id is the idempotency key for each operation in the batch, claimed per operation against inv_idempotency_keys. A single header key for the whole batch would be coarser than the grain the device retries at." },
  { route: "traceability/inv-traceability.controller.ts::updateLotStatus", commandClass: "CONVERGING", why: "Applies the supplied fields to the row named in the URL. Re-sending the same body leaves the same row, and nothing new is created for a retry to duplicate." },
  { route: "vendors/inv-vendors.controller.ts::create", commandClass: "DUPLICATES_ON_RETRY", why: "A retry after a timed-out first attempt raises a second vendor." },
  { route: "vendors/inv-vendors.controller.ts::update", commandClass: "CONVERGING", why: "Applies the supplied fields to the row named in the URL. Re-sending the same body leaves the same row, and nothing new is created for a retry to duplicate." },
  { route: "warehouses/inv-warehouses.controller.ts::create", commandClass: "DUPLICATES_ON_RETRY", why: "A retry after a timed-out first attempt raises a second warehouse." },
  { route: "warehouses/inv-warehouses.controller.ts::createLocation", commandClass: "DUPLICATES_ON_RETRY", why: "A retry after a timed-out first attempt raises a second location." },
  { route: "warehouses/inv-warehouses.controller.ts::grantWarehouseUser", commandClass: "CONVERGING", why: "Inserts the grant with onConflictDoNothing and reports granted:false when the row was already there, so a retry changes nothing." },
  { route: "warehouses/inv-warehouses.controller.ts::revokeWarehouseUser", commandClass: "CONVERGING", why: "Removing a row that is already gone is a no-op or a 404. There is no second document a retry could raise." },
  { route: "warehouses/inv-warehouses.controller.ts::update", commandClass: "CONVERGING", why: "Applies the supplied fields to the row named in the URL. Re-sending the same body leaves the same row, and nothing new is created for a retry to duplicate." },
  { route: "warehouses/inv-warehouses.controller.ts::updateLocation", commandClass: "CONVERGING", why: "Applies the supplied fields to the row named in the URL. Re-sending the same body leaves the same row, and nothing new is created for a retry to duplicate." },
  { route: "webhooks/webhook-delivery.controller.ts::runPost", commandClass: "REPEATABLE_OPERATION", why: "A cron entry point, not a user command. No browser or device ever retries it, and there is no client to mint a key." },
  { route: "webhooks/webhooks.controller.ts::create", commandClass: "DUPLICATES_ON_RETRY", why: "A retry after a timed-out first attempt raises a second webhook subscription, so every event is delivered twice." },
  { route: "webhooks/webhooks.controller.ts::remove", commandClass: "CONVERGING", why: "Removing a row that is already gone is a no-op or a 404. There is no second document a retry could raise." },
  { route: "webhooks/webhooks.controller.ts::retryEvent", commandClass: "REPEATABLE_OPERATION", why: "Re-delivers one webhook event. Re-delivery is the operation, and the subscriber is the party that must tolerate it." },
  { route: "webhooks/webhooks.controller.ts::update", commandClass: "CONVERGING", why: "Applies the supplied fields to the row named in the URL. Re-sending the same body leaves the same row, and nothing new is created for a retry to duplicate." },
];
