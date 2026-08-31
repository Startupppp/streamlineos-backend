import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const BACKEND_ROOT = resolve(SCRIPT_DIR, "../..");
const MODULES_DIR = join(BACKEND_ROOT, "src", "modules");

const SPEC_RE = /\.(spec|e2e-spec)\.ts$/;

const HTTP_MUTATION_RE = /^\s*@(?:Post|Put|Patch|Delete)\s*(?:\(|$)/;
const IDEMPOTENT_RE = /^\s*@Idempotent\b/;
const PUBLIC_RE = /^\s*@Public\b/;
const DECORATOR_LINE_RE = /^\s*@\w/;
const CLASS_PUBLIC_RE = /@Public\(\)\s*\n(?:\s*@[^\n]*\n)*\s*(?:export\s+)?(?:abstract\s+)?class\s/;

const CRITICAL_ROUTE_RE =
  /(?:^|\/)(?:checkout|purchase|payout|allocat|transfer|\/post$|\/ship$|\/receive$|\/dispatch$|\/adjust$|\/reverse$|count-post|invite|resend|publish|remind|approve|reject|submit|accept|decline|run-now|affiliate|referral|send-signin|test-send)(?:\/|$)/i;

const CRITICAL_METHOD_RE =
  /\b(?:checkout|purchaseAddon|purchaseCredits|createOrder|installApp|startTrial|registerAffiliate|requestAffiliatePayoutRequest|createReferral|submitEnterpriseQuote|approveEnterpriseQuote|rejectEnterpriseQuote|sendEnterpriseQuote|acceptEnterpriseQuote|initiateOrgTransfer|initiateModuleTransfer|acceptTransfer|declineTransfer|cancelTransfer|inviteUser|bulkInvite|resendInvite|sendSigninLink|invite|remind|testSend|allocate|runNow|submitForApproval|approveJournal|rejectJournal|publish|ship|postAdjustment|postTransfer|createAdjustment)\b/;

const FILE_EXCLUSIONS = [
  { fragment: "modules/portal/", reason: "portal-client" },
  { fragment: "modules/cron/", reason: "cron-endpoint" },
  { fragment: "razorpay-webhook", reason: "external-webhook" },
  { fragment: "payment-webhooks-public", reason: "external-webhook" },
  { fragment: "modules/webhooks/", reason: "external-webhook" },
  { fragment: "modules/ingress/", reason: "external-webhook" },
  { fragment: "modules/public/", reason: "public-route" },
];

const HANDLER_EXCLUSIONS = new Map([
  ["src/modules/organization/core/organization.controller.ts::acceptInvitation", "public-route"],
  ["src/modules/organization/core/organization.controller.ts::declineInvitation", "public-route"],
  ["src/modules/organization/core/organization.controller.ts::validateInvitation", "public-route"],
  ["src/modules/inventory/stock/inv-stock-adjustments.controller.ts::createAdjustment", "bespoke-mechanism"],
  ["src/modules/inventory/stock/inv-stock-adjustments.controller.ts::postAdjustment", "bespoke-mechanism"],
  ["src/modules/inventory/sales-orders/inv-sales-orders.controller.ts::reserve", "bespoke-mechanism"],
  ["src/modules/inventory/sales-orders/inv-sales-orders.controller.ts::ship", "bespoke-mechanism"],
  ["src/modules/inventory/shipments/shipments.controller.ts::ship", "bespoke-mechanism"],
  ["src/modules/inventory/counts/inv-cycle-counts.controller.ts::post", "bespoke-mechanism"],
  ["src/modules/inventory/returns/customer-returns.controller.ts::post", "bespoke-mechanism"],
  ["src/modules/inventory/returns/vendor-returns.controller.ts::post", "bespoke-mechanism"],
  ["src/modules/payroll/runs/runs.controller.ts::create", "bespoke-mechanism"],
  ["src/modules/payroll/runs/runs.controller.ts::generate", "bespoke-mechanism"],
  ["src/modules/payroll/runs/runs.controller.ts::recalculate", "bespoke-mechanism"],
  ["src/modules/payroll/payout/approvals.controller.ts::submitApproval", "bespoke-mechanism"],
  ["src/modules/payroll/payout/approvals.controller.ts::approveStage", "bespoke-mechanism"],
  ["src/modules/payroll/payout/approvals.controller.ts::rejectStage", "bespoke-mechanism"],
  ["src/modules/finance/controls/approvals.controller.ts::approve", "bespoke-mechanism"],
  ["src/modules/finance/controls/approvals.controller.ts::reject", "bespoke-mechanism"],
  ["src/modules/hr/recruitment/recruitment-candidate-records.controller.ts::updateReferral", "http-put-idempotent"],
]);

function isFileExcluded(relPath) {
  const normalized = relPath.replace(/\\/g, "/");
  return FILE_EXCLUSIONS.some(({ fragment }) => normalized.includes(fragment));
}

function parseHandlers(src, relPath) {
  if (CLASS_PUBLIC_RE.test(src)) return [];

  const lines = src.split("\n");
  const handlers = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!DECORATOR_LINE_RE.test(line)) { i++; continue; }

    const blockStart = i;
    let mutationDecoratorRoute = null;
    let hasIdempotent = false;
    let hasPublic = false;
    let j = i;

    while (j < lines.length && (DECORATOR_LINE_RE.test(lines[j]) || lines[j].trim() === "")) {
      const l = lines[j];
      if (HTTP_MUTATION_RE.test(l)) {
        const routeMatch = l.match(/@(?:Post|Put|Patch|Delete)\s*\(\s*["'`]([^"'`]*)["'`]\s*\)/);
        mutationDecoratorRoute = routeMatch ? routeMatch[1] : "";
      }
      if (IDEMPOTENT_RE.test(l)) hasIdempotent = true;
      if (PUBLIC_RE.test(l)) hasPublic = true;
      j++;
    }

    const methodLine = lines[j] ?? "";
    const methodMatch = methodLine.match(/^\s+(?:async\s+)?([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/);
    const methodName = methodMatch ? methodMatch[1] : null;

    if (mutationDecoratorRoute !== null && methodName) {
      const routeCritical = CRITICAL_ROUTE_RE.test("/" + mutationDecoratorRoute);
      const methodCritical = CRITICAL_METHOD_RE.test(methodName);

      if ((routeCritical || methodCritical) && !hasIdempotent && !hasPublic) {
        const handlerKey = `${relPath.replace(/\\/g, "/")}::${methodName}`;
        handlers.push({
          file: relPath,
          line: blockStart + 1,
          method: methodName,
          route: mutationDecoratorRoute,
          key: handlerKey,
        });
      }
    }

    i = j + 1;
  }

  return handlers;
}

if (args.includes("--self-test")) {
  const FENCED = [
    `  @Post(":surveyId/publish")`,
    `  @Idempotent("surveys.survey.publish")`,
    `  @RequirePermission("surveys:publish")`,
    `  publish(@Param("surveyId") surveyId: number, @CurrentUser() u: CurrentUserContext) {`,
    `    return this.forms.publish(u.orgId, surveyId);`,
    `  }`,
  ].join("\n");

  const UNFENCED = [
    `  @Post(":broadcastId/publish")`,
    `  @HttpCode(200)`,
    `  @UseGuards(PermissionGuard)`,
    `  @RequirePermission("notifications:broadcasts:manage")`,
    `  publish(`,
    `    @Param("broadcastId") broadcastId: number,`,
    `    @CurrentUser() u: CurrentUserContext,`,
    `  ) {`,
    `    return this.broadcastsService.publish(u.orgId, u.userId, broadcastId);`,
    `  }`,
  ].join("\n");

  const PUBLIC_ROUTE = [
    `  @Public()`,
    `  @Post("invitations/accept")`,
    `  acceptInvitation(@Query("token") token: string) {`,
    `    return this.invitations.accept(token);`,
    `  }`,
  ].join("\n");

  const BESPOKE = [
    `  @Post(":adjustmentId/post")`,
    `  @UseGuards(PermissionGuard)`,
    `  @RequirePermission("inventory:adjustments:post")`,
    `  postAdjustment(`,
    `    @Headers("idempotency-key") idempotencyKey: string,`,
    `    @Param("adjustmentId") adjustmentId: number,`,
    `  ) {`,
    `    if (!idempotencyKey) throw new BadRequestException("required");`,
    `    return this.adjustments.postAdjustment(u.orgId, adjustmentId, idempotencyKey);`,
    `  }`,
  ].join("\n");

  const ALREADY_FENCED = [
    `  @Post("allocations")`,
    `  @Idempotent("accounting.vendor-payment.allocate")`,
    `  @UseGuards(PermissionGuard)`,
    `  @RequirePermission("accounting:payables:manage")`,
    `  @HttpCode(200)`,
    `  allocate(`,
    `    @Body() body: ManualAllocationInput,`,
    `    @CurrentUser() u: CurrentUserContext,`,
    `  ) {`,
    `    return this.service.allocate(u.orgId, u.userId, body);`,
    `  }`,
  ].join("\n");

  const fencedResult = parseHandlers(FENCED, "surveys/surveys.controller.ts");
  const unfencedResult = parseHandlers(UNFENCED, "notifications/broadcasts.controller.ts");
  const publicResult = parseHandlers(PUBLIC_ROUTE, "organization/core/organization.controller.ts");
  const bespokeResult = parseHandlers(BESPOKE, "inventory/inv-stock-adjustments.controller.ts");
  const alreadyFencedResult = parseHandlers(ALREADY_FENCED, "finance/ap/vendor-payments-allocations.controller.ts");

  const checks = {
    fencedHandlerNotReported: fencedResult.length === 0,
    unfencedPublishIsDetected: unfencedResult.length === 1 && unfencedResult[0].method === "publish",
    unfencedHandlerHasCorrectRoute: unfencedResult[0]?.route === ":broadcastId/publish",
    publicRouteIsSkipped: publicResult.length === 0,
    alreadyFencedIsClean: alreadyFencedResult.length === 0,
    bespokeHandlerIsDetected: bespokeResult.length > 0,
  };

  const pass = Object.values(checks).every(Boolean);
  process.stdout.write(JSON.stringify({ selfTest: true, pass, checks }, null, 2) + "\n");
  process.exit(pass ? 0 : 1);
}

if (!existsSync(MODULES_DIR)) {
  process.stderr.write(`Cannot read modules dir: ${MODULES_DIR}\n`);
  process.exit(2);
}

function walkControllers(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkControllers(full));
    else if (entry.name.endsWith(".controller.ts") && !SPEC_RE.test(entry.name)) out.push(full);
  }
  return out;
}

const controllerFiles = walkControllers(MODULES_DIR);

const violations = [];
const excused = [];

for (const file of controllerFiles) {
  const rel = relative(BACKEND_ROOT, file).replace(/\\/g, "/");
  if (isFileExcluded(rel)) continue;

  const src = readFileSync(file, "utf8");
  const handlers = parseHandlers(src, rel);

  for (const h of handlers) {
    const excusedReason = HANDLER_EXCLUSIONS.get(h.key);
    if (excusedReason) excused.push({ ...h, reason: excusedReason });
    else violations.push(h);
  }
}

if (controllerFiles.length < 50) {
  process.stderr.write(
    `Found only ${controllerFiles.length} controllers. That is a broken scanner, not a clean codebase.\n`,
  );
  process.exit(2);
}

console.log(`Controllers scanned   ${controllerFiles.length}`);
console.log(`Handlers in scope     ${violations.length + excused.length}`);
console.log("");

if (excused.length > 0) {
  console.log("EXCLUDED BY DESIGN — named, not hidden:");
  for (const h of excused)
    console.log(`  SKIP  ${h.file}:${h.line}  ${h.method}("${h.route}")  — ${h.reason}`);
  console.log("");
}

if (violations.length === 0) {
  console.log("OK — every in-scope mutating handler carries @Idempotent.");
  process.exit(0);
}

console.error("UNFENCED RETRYABLE COMMANDS:");
for (const h of violations.sort((a, b) => a.file.localeCompare(b.file)))
  console.error(`  FAIL  ${h.file}:${h.line}  ${h.method}("${h.route}")  — add @Idempotent`);
console.error("");
console.error(`FAIL — ${violations.length} in-scope handler(s) carry no @Idempotent fence.`);
process.exit(1);
