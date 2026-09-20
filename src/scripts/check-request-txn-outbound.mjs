import { readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ANY_ROUTE_DECORATOR,
  buildClassIndex,
  findRoutes,
  injectedTypes,
  isSpec,
  makeReaches,
  walk,
} from "./lib/route-scan.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(__dirname, "../..");
const SRC = join(ROOT, "src");
const MODULES = join(SRC, "modules");

const OUTBOUND =
  /(?<![.\w])fetch\s*\(|(?<![.\w])postSafeWebhook\s*\(|(?<![.\w])callProvider\s*\(|(?<![.\w])outboundRequest\s*\(|\baxios\s*\.\s*(?:get|post|put|patch|delete|request)\s*\(|\bsendEmailOnceDirect\s*\(/;

const MAX_HOPS = 3;
const MIN_CONTROLLERS = 200;
const MIN_ROUTES = 1500;

/*
  Each entry carries the decision that put it here. A bare list turns into a
  place to drop a route nobody wanted to think about; a reason has to be written
  by someone who looked. "HOLDS" means the connection really is held and the
  cost was accepted or deferred — those are work, not settled.
*/
const FROZEN = new Map([
  [
    "modules/build/core/projects-webhooks.controller.ts#sendTest",
    "HOLDS. Awaited so the user is shown the delivery result. 10s x 5 attempts with 1-30s backoff, so the worst case is minutes on one connection. Needs the dispatch service to own its transactions before it can opt out.",
  ],
  [
    "modules/email/controllers/notifications-dispatch.controller.ts#dispatch",
    "HOLDS. Awaited; the send outcome per channel is the response body. Email writes outbox status after the provider call, so an opt-out alone would leave those writes with no tenant context. Budgets 5s inline email, 15s Twilio.",
  ],
  [
    "modules/feedbucket/feedbucket.controller.ts#analyzeSubmission",
    "HOLDS, and the longest of the eight: a 60s standard-tier LLM call with the submission update after it. Opt-out needs the service to own its read and write transactions.",
  ],
  [
    "modules/feedbucket/feedbucket.controller.ts#createTicketFromAnalysis",
    "HOLDS, same 60s call, and only when the submission has no analysis yet. Also writes a ticket through ProjectsTicketsService, whose atomicity has to be settled before this one is split.",
  ],
  [
    "modules/hr/automations/hr-webhooks.controller.ts#redeliver",
    "Detached: the fetch is fired through detachDelivery, outside the tenant context, and the status write opens its own transaction. No connection is held. Frozen because the scan cannot tell an awaited call from a detached one.",
  ],
  [
    "modules/hr/automations/hr-webhooks.controller.ts#test",
    "Detached, exactly as redeliver above. No connection is held.",
  ],
  [
    "modules/support/core/support-reports.controller.ts#getOverview",
    "Redis, not a third-party provider, and only on the default unscoped filters. Read-only: nothing is written anywhere in the path, and each Redis op is capped at 3s with a direct-query fallback. Accepted.",
  ],
  [
    "modules/webhooks/webhooks.controller.ts#retryLog",
    "HOLDS, deliberately. webhooks-dispatch.service.ts:61-66 documents that retryLog calls deliver from inside the live request transaction and that reusing it is correct, because the log insert must commit with the retry.",
  ],
]);

function callsOutbound(body) {
  return OUTBOUND.test(body);
}

const reaches = makeReaches({
  directly: callsOutbound,
  maxHops: MAX_HOPS,
  strip: (body) => body,
  followSameClass: true,
});

function scan() {
  const all = walk(SRC);
  const classIndex = buildClassIndex(all);
  const controllers = walk(MODULES).filter(
    (file) => /\.controller\.ts$/.test(file) && !isSpec(file),
  );

  const holding = [];
  let routes = 0;

  for (const file of controllers) {
    const source = readFileSync(file, "utf8");
    const found = findRoutes(source, { collect: ANY_ROUTE_DECORATOR });
    if (found.length === 0) continue;
    const types = injectedTypes(source);
    const rel = relative(SRC, file).replace(/\\/g, "/");

    for (const route of found) {
      routes++;
      if (reaches(route.body, classIndex, { types, source, file }, 0, new Set()))
        holding.push(`${rel}#${route.handler}`);
    }
  }

  return {
    controllers: controllers.length,
    routes,
    holding: [...new Set(holding)].sort(),
  };
}

function selfTest() {
  const failures = [];

  const routes = findRoutes(
    `
  @Post("checkout")
  async checkout() {
    return this.provider.createOrder(input);
  }

  @Post("safe")
  @NoTenantTransaction()
  async safe() {
    await fetch(url);
  }
`,
    { collect: ANY_ROUTE_DECORATOR },
  );
  if (routes.length !== 1)
    failures.push(`collected ${routes.length} non-opted-out routes, expected 1`);
  if (routes[0]?.handler !== "checkout")
    failures.push(`collected ${routes[0]?.handler ?? "nothing"}, expected checkout`);

  if (!callsOutbound("await fetch(url);")) failures.push("fetch( not detected");
  if (!callsOutbound("await postSafeWebhook(u, b, h, 1, 2);"))
    failures.push("postSafeWebhook( not detected");
  if (!callsOutbound("await callProvider(d, fn, breaker);"))
    failures.push("callProvider( not detected");
  if (!callsOutbound("await axios.post(url, body);")) failures.push("axios.post not detected");
  if (callsOutbound("const prefetched = cache.get(key);"))
    failures.push("plain cache read misread as outbound");

  if (callsOutbound("const read = await this.fetch(a, b);"))
    failures.push("a private method named fetch was misread as the global fetch");
  if (!callsOutbound("const r = await fetch(url);")) failures.push("bare fetch( not detected");

  const classOptOut = findRoutes(
    `
@NoTenantTransaction()
export class StreamController {
  @Post("chat")
  async chat() {
    await fetch(url);
  }
}
`,
    { collect: ANY_ROUTE_DECORATOR },
  );
  if (classOptOut.length !== 0)
    failures.push("class-level @NoTenantTransaction was not honoured");

  if (failures.length > 0) {
    for (const failure of failures) console.error(`  ${failure}`);
    console.error("check-request-txn-outbound self-test FAILED");
    process.exit(3);
  }
  console.log("check-request-txn-outbound self-test passed");
}

function main() {
  if (process.argv.includes("--self-test")) {
    selfTest();
    return;
  }

  const { controllers, routes, holding } = scan();

  if (controllers < MIN_CONTROLLERS || routes < MIN_ROUTES) {
    console.error(
      `check-request-txn-outbound: resolved only ${controllers} controller(s) and ${routes} route(s) ` +
        `(floor ${MIN_CONTROLLERS}/${MIN_ROUTES}). The scan is broken, not the codebase.`,
    );
    process.exit(2);
  }

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ controllers, routes, holding }, null, 2));
    return;
  }

  const unfrozen = holding.filter((entry) => !FROZEN.has(entry));
  const departed = [...FROZEN.keys()].filter((entry) => !holding.includes(entry));

  if (departed.length > 0) {
    console.error(
      `check-request-txn-outbound: ${departed.length} frozen route(s) no longer reach an outbound ` +
        `call. Remove them from FROZEN — a stale entry silently re-freezes the route if it regresses.`,
    );
    for (const entry of departed) console.error(`  ${entry}`);
    process.exit(1);
  }

  if (unfrozen.length > 0) {
    console.error(
      `check-request-txn-outbound: ${unfrozen.length} route(s) call out over the network while the ` +
        `request's tenant transaction is held. The pool is small, so each one costs a pooled ` +
        `connection for the whole round trip. Add @NoTenantTransaction() and open short ` +
        `transactions around the DB work, or freeze it with a reason.`,
    );
    for (const entry of unfrozen) console.error(`  ${entry}`);
    process.exit(1);
  }

  console.log(
    `check-request-txn-outbound: ${routes} route(s) across ${controllers} controller(s); ` +
      `${holding.length} holding a connection across an outbound call (frozen).`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
