import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(__dirname, "../..");
const MODULES = join(ROOT, "src", "modules");

const GATEWAY_CALL =
  /\b(?:invokeText|invokeStructured|streamText|invokeTextWithUsage|invokeStructuredWithUsage|streamTextWithUsage|invokeStructuredWithImageWithUsage|invokeWithUsage)\s*\(/;

const ROUTE_DECORATOR = /^\s*@(Get|Post|Put|Patch|Delete|All|Sse)\s*\(/;
const OPT_OUT = /^\s*@NoTenantTransaction\s*\(/;
const HANDLER = /^\s*(?:public\s+|private\s+|protected\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/;

const FROZEN = new Set([
  "modules/accounting/compliance/compliance.controller.ts#getForDocument",
  "modules/ai/core/controllers/chat-assistant.controller.ts#clearHistory",
  "modules/ai/core/controllers/chat-assistant.controller.ts#createConversation",
  "modules/ai/core/controllers/chat-assistant.controller.ts#deleteConversation",
  "modules/ai/core/controllers/chat-assistant.controller.ts#getConversationMessages",
  "modules/ai/core/controllers/chat-assistant.controller.ts#getHistory",
  "modules/ai/core/controllers/chat-assistant.controller.ts#listConversations",
  "modules/ai/core/controllers/chat-assistant.controller.ts#renameConversation",
  "modules/audit-log/audit-log.controller.ts#list",
  "modules/audit-log/audit-log.controller.ts#listActions",
  "modules/audit-log/audit-log.controller.ts#listTargetTypes",
  "modules/billing/core/billing-marketplace.controller.ts#configureAutoTopUp",
  "modules/billing/core/billing-marketplace.controller.ts#getAiCredits",
  "modules/billing/core/billing-marketplace.controller.ts#getAiCreditsUsage",
  "modules/billing/core/billing-marketplace.controller.ts#installApp",
  "modules/billing/core/billing-marketplace.controller.ts#listAiCreditTransactions",
  "modules/billing/core/billing-marketplace.controller.ts#listApps",
  "modules/billing/core/billing-marketplace.controller.ts#startTrial",
  "modules/billing/core/billing-marketplace.controller.ts#uninstallApp",
  "modules/billing/core/billing.controller.ts#confirmCheckout",
  "modules/billing/core/billing.controller.ts#getBillingProfile",
  "modules/billing/core/billing.controller.ts#getEntitlements",
  "modules/billing/core/billing.controller.ts#getMarketplace",
  "modules/billing/core/billing.controller.ts#getPlans",
  "modules/billing/core/billing.controller.ts#getSeatInfo",
  "modules/billing/core/billing.controller.ts#getSubscription",
  "modules/billing/core/billing.controller.ts#getSummary",
  "modules/billing/core/billing.controller.ts#listAddons",
  "modules/billing/core/billing.controller.ts#listCoupons",
  "modules/billing/core/billing.controller.ts#listProvisioningFailures",
  "modules/billing/core/billing.controller.ts#updateBillingProfile",
  "modules/billing/core/billing.controller.ts#validateCoupon",
  "modules/build/comment-drafts/comment-drafts.controller.ts#deleteAll",
  "modules/build/comment-drafts/comment-drafts.controller.ts#deleteByTicket",
  "modules/build/comment-drafts/comment-drafts.controller.ts#deleteOne",
  "modules/build/comment-drafts/comment-drafts.controller.ts#listMine",
  "modules/build/comment-drafts/comment-drafts.controller.ts#recordFailure",
  "modules/build/comment-drafts/comment-drafts.controller.ts#upsert",
  "modules/chat/chat-huddles.controller.ts#getActiveHuddle",
  "modules/chat/chat-huddles.controller.ts#heartbeat",
  "modules/chat/chat-huddles.controller.ts#invite",
  "modules/chat/chat-huddles.controller.ts#joinHuddle",
  "modules/chat/chat-huddles.controller.ts#kickParticipant",
  "modules/chat/chat-huddles.controller.ts#leaveHuddle",
  "modules/contacts/contacts.controller.ts#bulkImport",
  "modules/contacts/contacts.controller.ts#create",
  "modules/contacts/contacts.controller.ts#get",
  "modules/contacts/contacts.controller.ts#list",
  "modules/contacts/contacts.controller.ts#remove",
  "modules/contacts/contacts.controller.ts#search",
  "modules/contacts/contacts.controller.ts#update",
  "modules/contacts/contacts.controller.ts#vcard",
  "modules/hr/config/hr-email-templates.controller.ts#create",
  "modules/hr/config/hr-email-templates.controller.ts#list",
  "modules/hr/config/hr-email-templates.controller.ts#remove",
  "modules/hr/config/hr-email-templates.controller.ts#update",
  "modules/hr/recruitment/recruitment-candidate-records.controller.ts#FileInterceptor",
  "modules/hr/recruitment/recruitment-candidate-records.controller.ts#addVaultDocument",
  "modules/hr/recruitment/recruitment-candidate-records.controller.ts#createCalibration",
  "modules/hr/recruitment/recruitment-candidate-records.controller.ts#createReferenceCheck",
  "modules/hr/recruitment/recruitment-candidate-records.controller.ts#createReferral",
  "modules/hr/recruitment/recruitment-candidate-records.controller.ts#deleteReferenceCheck",
  "modules/hr/recruitment/recruitment-candidate-records.controller.ts#deleteVaultDocument",
  "modules/hr/recruitment/recruitment-candidate-records.controller.ts#generateDocument",
  "modules/hr/recruitment/recruitment-candidate-records.controller.ts#generateRolloutDocuments",
  "modules/hr/recruitment/recruitment-candidate-records.controller.ts#getActivity",
  "modules/hr/recruitment/recruitment-candidate-records.controller.ts#listCalibration",
  "modules/hr/recruitment/recruitment-candidate-records.controller.ts#listDocuments",
  "modules/hr/recruitment/recruitment-candidate-records.controller.ts#listReferenceChecks",
  "modules/hr/recruitment/recruitment-candidate-records.controller.ts#listReferrals",
  "modules/hr/recruitment/recruitment-candidate-records.controller.ts#listRolloutDocuments",
  "modules/hr/recruitment/recruitment-candidate-records.controller.ts#listVault",
  "modules/hr/recruitment/recruitment-candidate-records.controller.ts#listVaultAccessLogs",
  "modules/hr/recruitment/recruitment-candidate-records.controller.ts#updateCalibration",
  "modules/hr/recruitment/recruitment-candidate-records.controller.ts#updateReferenceCheck",
  "modules/hr/recruitment/recruitment-candidate-records.controller.ts#updateReferral",
  "modules/hr/recruitment/recruitment-candidate-records.controller.ts#viewDocument",
  "modules/ingress/adapters/crm-mailbox.controller.ts#disable",
  "modules/ingress/adapters/crm-mailbox.controller.ts#enable",
  "modules/ingress/adapters/crm-mailbox.controller.ts#list",
  "modules/ingress/adapters/crm-mailbox.controller.ts#push",
  "modules/inventory/ai/inv-ai-explain.controller.ts#confirmReorderProposal",
  "modules/inventory/ai/inv-ai-explain.controller.ts#getOpsBrief",
  "modules/inventory/ai/reports/inv-report-builder.controller.ts#catalog",
  "modules/inventory/ai/reports/inv-report-builder.controller.ts#export",
  "modules/kb/retrieval/kb-ask.controller.ts#clearHistory",
  "modules/kb/retrieval/kb-ask.controller.ts#createKnowledgeGap",
  "modules/kb/retrieval/kb-ask.controller.ts#getHistory",
  "modules/kb/wiki/kb-import-export.controller.ts#cancelImportJob",
  "modules/kb/wiki/kb-import-export.controller.ts#downloadExportJob",
  "modules/kb/wiki/kb-import-export.controller.ts#dryRunImport",
  "modules/kb/wiki/kb-import-export.controller.ts#getImportJob",
  "modules/kb/wiki/kb-import-export.controller.ts#importPages",
  "modules/kb/wiki/kb-import-export.controller.ts#listExportJobs",
  "modules/kb/wiki/kb-import-export.controller.ts#listImportJobs",
  "modules/kb/wiki/kb-import-export.controller.ts#retryImportJob",
  "modules/kb/wiki/kb-sources.controller.ts#articleIngestionStatus",
  "modules/kb/wiki/kb-sources.controller.ts#get",
  "modules/kb/wiki/kb-sources.controller.ts#list",
  "modules/kb/wiki/kb-sources.controller.ts#pageIngestionStatus",
  "modules/kb/wiki/kb-sources.controller.ts#remove",
  "modules/mail/mail.controller.ts#aiInboxSummary",
  "modules/mail/mail.controller.ts#getAttachment",
  "modules/mail/mail.controller.ts#getMessage",
  "modules/mail/mail.controller.ts#getThread",
  "modules/mail/mail.controller.ts#listAccounts",
  "modules/mail/mail.controller.ts#listMessages",
  "modules/mail/mail.controller.ts#performAction",
  "modules/mail/mail.controller.ts#replyMail",
  "modules/mail/mail.controller.ts#sendMail",
  "modules/notifications/notifications.controller.ts#approve",
  "modules/notifications/notifications.controller.ts#archive",
  "modules/notifications/notifications.controller.ts#bulkArchive",
  "modules/notifications/notifications.controller.ts#bulkDelete",
  "modules/notifications/notifications.controller.ts#bulkMarkRead",
  "modules/notifications/notifications.controller.ts#clearAll",
  "modules/notifications/notifications.controller.ts#list",
  "modules/notifications/notifications.controller.ts#markAllRead",
  "modules/notifications/notifications.controller.ts#markRead",
  "modules/notifications/notifications.controller.ts#pin",
  "modules/notifications/notifications.controller.ts#reject",
  "modules/notifications/notifications.controller.ts#snooze",
  "modules/notifications/notifications.controller.ts#softDelete",
  "modules/notifications/notifications.controller.ts#unarchive",
  "modules/notifications/notifications.controller.ts#unpin",
  "modules/notifications/notifications.controller.ts#unreadCount",
  "modules/organization/core/organization-lifecycle.controller.ts#archiveOrg",
  "modules/organization/core/organization-lifecycle.controller.ts#cancelPurge",
  "modules/organization/core/organization-lifecycle.controller.ts#deleteOrg",
  "modules/organization/core/organization-lifecycle.controller.ts#leaveOrg",
  "modules/organization/core/organization-lifecycle.controller.ts#listLegalHolds",
  "modules/organization/core/organization-lifecycle.controller.ts#placeLegalHold",
  "modules/organization/core/organization-lifecycle.controller.ts#releaseLegalHold",
  "modules/organization/core/organization-lifecycle.controller.ts#schedulePurge",
  "modules/organization/core/organization.controller.ts#acceptInvitation",
  "modules/organization/core/organization.controller.ts#declineInvitation",
  "modules/organization/core/organization.controller.ts#getSettings",
  "modules/organization/core/organization.controller.ts#requestInvitationOtp",
  "modules/organization/core/organization.controller.ts#updateSecuritySettings",
  "modules/organization/core/organization.controller.ts#updateSettings",
  "modules/organization/core/organization.controller.ts#validateInvitationToken",
  "modules/organization/setup/org.controller.ts#listMembers",
  "modules/payroll/insights/payroll-ai-explain.controller.ts#aiCapabilities",
  "modules/support/core/support-ai.controller.ts#getAiReport",
  "modules/support/core/support-ai.controller.ts#getSettings",
  "modules/support/core/support-ai.controller.ts#listSuggestions",
  "modules/support/core/support-ai.controller.ts#resolveSuggestion",
  "modules/support/core/support-ai.controller.ts#updateSettings",
  "modules/support/core/support-kb-engagement.controller.ts#createAttachment",
  "modules/support/core/support-kb-engagement.controller.ts#createComment",
  "modules/support/core/support-kb-engagement.controller.ts#deleteAttachment",
  "modules/support/core/support-kb-engagement.controller.ts#deleteComment",
  "modules/support/core/support-kb-engagement.controller.ts#getArticleIndexStatus",
  "modules/support/core/support-kb-engagement.controller.ts#getAttachmentDownloadUrl",
  "modules/support/core/support-kb-engagement.controller.ts#listAttachments",
  "modules/support/core/support-kb-engagement.controller.ts#listComments",
  "modules/support/core/support-kb-engagement.controller.ts#listFeedback",
  "modules/support/kb-gap/support-kb-gap.controller.ts#detectGaps",
  "modules/support/kb-gap/support-kb-gap.controller.ts#listGaps",
  "modules/support/kb-gap/support-kb-gap.controller.ts#patchGap",
]);

const SKIP_DIRS = new Set(["node_modules", "dist", "__tests__"]);

function isSource(path) {
  return extname(path) === ".ts" && !/\.(spec|e2e-spec|test|d)\.ts$/.test(path);
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (isSource(full)) out.push(full);
  }
  return out;
}

export function findRoutes(source) {
  const lines = source.split("\n");
  const classLevel = lines.some(
    (line, index) => OPT_OUT.test(line) && lines.slice(index).some((l) => /^export class /.test(l)) &&
      !lines.slice(0, index).some((l) => /^export class /.test(l)),
  );

  const routes = [];
  let pendingRoute = false;
  let pendingOptOut = false;

  for (const line of lines) {
    if (ROUTE_DECORATOR.test(line)) {
      pendingRoute = true;
      continue;
    }
    if (OPT_OUT.test(line)) {
      if (pendingRoute) pendingOptOut = true;
      continue;
    }
    if (/^\s*@/.test(line) || line.trim() === "") continue;

    if (pendingRoute) {
      const handler = HANDLER.exec(line);
      if (handler) {
        routes.push({ handler: handler[1], optedOut: pendingOptOut || classLevel });
        pendingRoute = false;
        pendingOptOut = false;
      }
    }
  }

  return routes;
}

function scan() {
  const files = walk(MODULES);
  const inTransaction = [];
  let controllers = 0;
  let routes = 0;

  for (const file of files) {
    if (!/\.controller\.ts$/.test(file)) continue;

    const source = readFileSync(file, "utf8");
    const found = findRoutes(source);
    if (!found.some((route) => route.optedOut)) continue;

    controllers++;
    const rel = relative(join(ROOT, "src"), file).replace(/\\/g, "/");
    for (const route of found) {
      routes++;
      if (!route.optedOut) inTransaction.push(`${rel}#${route.handler}`);
    }
  }

  return { controllers, routes, inTransaction: inTransaction.sort() };
}

function selfTest() {
  const failures = [];

  const handlerLevel = findRoutes(`
  @Post(":id/explain")
  @NoTenantTransaction()
  async explain() {}

  @Post(":id/other")
  async other() {}
`);
  if (handlerLevel.length !== 2) failures.push(`found ${handlerLevel.length} routes, expected 2`);
  else {
    if (!handlerLevel[0].optedOut) failures.push("missed a handler-level opt-out");
    if (handlerLevel[1].optedOut) failures.push("called a bare route opted out");
  }

  const classLevel = findRoutes(`
@Controller("crm/ai")
@NoTenantTransaction()
export class CrmAiController {
  @Post("summarise")
  async summarise() {}
}
`);
  if (classLevel.length !== 1) failures.push("lost a route under a class-level opt-out");
  else if (!classLevel[0].optedOut) failures.push("missed a class-level opt-out");

  const decoratorsBetween = findRoutes(`
  @Post(":id/explain")
  @NoTenantTransaction()
  @RequirePermission("payroll:me:view")
  @Validate({ params: schema })
  async explainPayslip() {}
`);
  if (decoratorsBetween.length !== 1) failures.push("lost a route behind stacked decorators");
  else if (!decoratorsBetween[0].optedOut)
    failures.push("missed an opt-out separated from its handler by other decorators");

  const live = scan();
  if (live.controllers < 8)
    failures.push(`found only ${live.controllers} AI controllers — the scan has stopped reaching them`);
  if (live.routes < 20)
    failures.push(`reached only ${live.routes} AI routes — a zero here would be vacuous`);

  return failures;
}

function main() {
  const args = process.argv.slice(2);

  if (args.includes("--self-test")) {
    const failures = selfTest();
    if (failures.length > 0) {
      console.error("check-ai-route-tenant-optout self-test FAILED:");
      for (const failure of failures) console.error(`  - ${failure}`);
      process.exit(3);
    }
    console.log("check-ai-route-tenant-optout self-test passed");
    return;
  }

  const result = scan();

  if (args.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.controllers < 8 || result.routes < 20) {
    console.error(
      `check-ai-route-tenant-optout: reached ${result.controllers} AI controllers and ${result.routes} routes — ` +
        "below the floor. A pass here would be vacuous; fix the scan, not the floor.",
    );
    process.exit(2);
  }

  const added = result.inTransaction.filter((route) => !FROZEN.has(route));
  const stale = [...FROZEN].filter((route) => !result.inTransaction.includes(route));

  if (stale.length > 0) {
    console.error(
      "check-ai-route-tenant-optout: these routes were fixed — remove them from FROZEN so the ratchet holds:",
    );
    for (const route of stale) console.error(`  - ${route}`);
    process.exit(1);
  }

  if (added.length > 0) {
    console.error(
      `check-ai-route-tenant-optout: ${added.length} AI route(s) run inside the request transaction.\n` +
        "The handler holds one of DB_POOL_MAX connections for the length of the model call.\n" +
        "Add @NoTenantTransaction() and wrap the handler's reads in runInTenantTransaction,\n" +
        "as the streaming siblings in the same files already do.\n",
    );
    for (const route of added) console.error(`  - ${route}`);
    process.exit(1);
  }

  console.log(
    `check-ai-route-tenant-optout: ${result.routes} route(s) across ${result.controllers} AI controller(s); ` +
      `${result.inTransaction.length} still inside the transaction (frozen).`,
  );
}

main();
