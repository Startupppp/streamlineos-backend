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
  "modules/inventory/ai/inv-ai-explain.controller.ts#confirmReorderProposal",
  "modules/inventory/ai/inv-ai-explain.controller.ts#getDigest",
  "modules/inventory/ai/inv-ai-explain.controller.ts#getOpsBrief",
  "modules/inventory/ai/inv-ai-explain.controller.ts#getReorderProposal",
  "modules/inventory/ai/inv-ai-explain.controller.ts#getSupplierDelayBriefing",
  "modules/inventory/ai/reports/inv-report-builder.controller.ts#catalog",
  "modules/inventory/ai/reports/inv-report-builder.controller.ts#export",
  "modules/kb/retrieval/kb-ask.controller.ts#clearHistory",
  "modules/kb/retrieval/kb-ask.controller.ts#getHistory",
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
  "modules/organization/core/organization.controller.ts#updateSecuritySettings",
  "modules/organization/core/organization.controller.ts#updateSettings",
  "modules/organization/core/organization.controller.ts#validateInvitationToken",
  "modules/organization/setup/org.controller.ts#listMembers",
  "modules/payroll/insights/payroll-ai-explain.controller.ts#aiCapabilities",
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
