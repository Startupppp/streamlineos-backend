import { readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ANY_ROUTE_DECORATOR,
  buildClassIndex,
  buildFunctionIndex,
  findRoutes,
  injectedTypes,
  isSpec,
  makeReaches,
  makeStripEscapedRegions,
  methodBody,
  parameterTypes,
  signatureOf,
  walk,
} from "./lib/route-scan.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(__dirname, "../..");
const SRC = join(ROOT, "src");
const MODULES = join(SRC, "modules");

const OUTBOUND =
  /(?<![.\w])fetch\s*\(|(?<![.\w])postSafeWebhook\s*\(|(?<![.\w])callProvider\s*\(|(?<![.\w])outboundRequest\s*\(|\baxios\s*\.\s*(?:get|post|put|patch|delete|request)\s*\(|\bsendEmailOnceDirect\s*\(/;

/*
  The LLM leaves the process through `ChatOpenAI` (`@langchain/openai`), not
  `fetch` or `axios`, so none of the patterns above can see an AI call — every
  route awaiting a 30-60s provider round trip inside the request transaction was
  invisible here until this was added.

  These are counted against a CEILING rather than a frozen list, because a
  frozen entry is supposed to carry the decision that put it there and 24 of
  these have not been read hop by hop yet. A ceiling claims only what is true:
  the number may fall, never rise.
*/
const AI_OUTBOUND = /\binvoke(?:Text|Structured|Chat)[A-Za-z]*\s*\(/;
const AI_CEILING = 24;

const MAX_HOPS = 6;
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
    "modules/automation/automation.controller.ts#testAutomation",
    "HOLDS. Testing a rule whose action is an email awaits sendEmailOnceDirect six hops down, inside the request transaction. Budget is 5s only when the row reproduces the send; with cc/bcc/replyTo/attachments it is unbounded. Verified by reading every hop.",
  ],
  [
    "modules/support/core/support-automations.controller.ts#testAutomation",
    "HOLDS, the same six-hop chain through AutomationService.testRule. Both rule-test routes were invisible to this gate until it learned to unwrap Pick<EmailOutboxService, ...>.",
  ],
  [
    "modules/build/core/projects-webhooks.controller.ts#sendTest",
    "HOLDS. Awaited so the user is shown the delivery result. 10s x 5 attempts with 1-30s backoff, so the worst case is minutes on one connection. Needs the dispatch service to own its transactions before it can opt out.",
  ],
  [
    "modules/email/controllers/notifications-dispatch.controller.ts#dispatch",
    "HOLDS, and an opt-out here would be WORSE than the hold. email_outbox and email_suppressions carry nullable-aware RLS, and the outbox row takes its org from the ambient context — with no context it is written as a PLATFORM row instead of failing, so the send silently loses tenant attribution and the suppression read silently misses org-specific entries. Fix the scope resolution before touching the decorator.",
  ],
  [
    "modules/feedbucket/feedbucket.controller.ts#analyzeSubmission",
    "HOLDS, and the longest of the six: a 60s standard-tier LLM call with the submission update after it. AI credits are reserved before the provider call and settled after, both on the ambient transaction, so the org_ai_credits row stays locked for the whole 60s.",
  ],
  [
    "modules/feedbucket/feedbucket.controller.ts#createTicketFromAnalysis",
    "HOLDS, same 60s call, and splitting it naively creates DUPLICATE TICKETS. The only guard against a second ticket is submission.linkedTicketId, which is written after createFromFeedback commits; today one ambient transaction makes them atomic. Split them and a failure between the two leaves a ticket with no link, and the retry — the route has no @Idempotent and no unique constraint — makes another. Needs an idempotency fence first.",
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

/*
  Work that has left the request. `registerAfterCommit` runs its hook in a fresh
  transaction once this one has committed, `runOutsideTenantContext` exits the
  async-local context so the continuation cannot inherit the request's tx, and a
  `void`-ed call is not awaited at all. In none of those does the outbound call
  happen while the connection is still borrowed — so a scan that counted them
  reported a hold that does not exist. Measured: without this, four of the
  e-sign and leads routes read as holds and were provably not.
*/
const DETACHERS = ["registerAfterCommit", "runOutsideTenantContext", "drainAfterCommitHooks"];
const stripDetachers = DETACHERS.map((name) => makeStripEscapedRegions(name));
const VOIDED = /\bvoid\s+[^;]*;/g;

function stripDetached(body) {
  let out = body.replace(VOIDED, " ");
  for (const strip of stripDetachers) out = strip(out);
  return out;
}

function callsOutbound(body) {
  return OUTBOUND.test(stripDetached(body));
}

function callsAnyProvider(body) {
  const visible = stripDetached(body);
  return OUTBOUND.test(visible) || AI_OUTBOUND.test(visible);
}

function scan() {
  const all = walk(SRC);
  const classIndex = buildClassIndex(all);
  const functionIndex = buildFunctionIndex(all);
  const walkOptions = {
    maxHops: MAX_HOPS,
    strip: stripDetached,
    followSameClass: true,
    functionIndex,
  };
  const reachesAny = makeReaches({ ...walkOptions, directly: callsAnyProvider });
  const reaches = makeReaches({ ...walkOptions, directly: callsOutbound });
  const controllers = walk(MODULES).filter(
    (file) => /\.controller\.ts$/.test(file) && !isSpec(file),
  );

  const holding = [];
  const aiHolding = [];
  let routes = 0;

  for (const file of controllers) {
    const source = readFileSync(file, "utf8");
    const found = findRoutes(source, { collect: ANY_ROUTE_DECORATOR });
    if (found.length === 0) continue;
    const types = injectedTypes(source);
    const rel = relative(SRC, file).replace(/\\/g, "/");

    for (const route of found) {
      routes++;
      const where = { types, source, file };
      if (!reachesAny(route.body, classIndex, where, 0, new Set())) continue;
      /*
        Re-walked with the non-AI predicate only, so a route reaching both is
        reported where the stricter rule applies rather than counted twice.
      */
      if (reaches(route.body, classIndex, where, 0, new Set()))
        holding.push(`${rel}#${route.handler}`);
      else aiHolding.push(`${rel}#${route.handler}`);
    }
  }

  return {
    controllers: controllers.length,
    routes,
    holding: [...new Set(holding)].sort(),
    aiHolding: [...new Set(aiHolding)].sort(),
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

  if (callsOutbound("await this.gateway.invokeTextWithUsage(opts);"))
    failures.push("an AI call was counted against the frozen list instead of the ceiling");
  if (!callsAnyProvider("await this.gateway.invokeTextWithUsage(opts);"))
    failures.push("invokeTextWithUsage( not detected as a provider call");
  if (!callsAnyProvider("await this.gateway.invokeStructured(opts);"))
    failures.push("invokeStructured( not detected as a provider call");
  if (callsAnyProvider("const ok = invoker.check(value);"))
    failures.push("a name merely starting with invoke was read as a gateway call");

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

  const multiLineDecorator = findRoutes(
    `
  @Post("upload")
  @UseInterceptors(
    FileInterceptor("file", { limits: { fileSize: 10 } }),
  )
  resumeParse() {
    await fetch(url);
  }
`,
    { collect: ANY_ROUTE_DECORATOR },
  );
  if (multiLineDecorator[0]?.handler !== "resumeParse")
    failures.push(
      `a decorator spanning lines named ${multiLineDecorator[0]?.handler ?? "nothing"} as the handler, ` +
        `which also drops the real route from the scan`,
    );

  /*
    The two resolution paths that exist for receivers the `this.<prop>` walk
    cannot see. Both found nothing on the current tree, so without these they
    would be machinery nobody had ever watched work.
  */
  if (parameterTypes("(gmail: GmailMailProvider, userId: string)").get("gmail") !== "GmailMailProvider")
    failures.push("a declared parameter type was not resolved");

  /*
    The three findings this gate reported wrongly before, each pinned to the
    construct that caused it.
  */
  if (
    injectedTypes('constructor(\n  private readonly outbox: Pick<EmailOutboxService, "enqueueAndTry">,\n) {}').get(
      "outbox",
    ) !== "EmailOutboxService"
  )
    failures.push("Pick<Owner, …> was not unwrapped, so the walk stops one hop short of the provider");
  if (injectedTypes("constructor(\n  private readonly db: Db,\n) {}").get("db") !== "Db")
    failures.push("a plain injected type was broken by the unwrapping");
  if (callsOutbound("if (!registerAfterCommit(() => this.deliver(u))) return;"))
    failures.push("an after-commit hook was counted as a hold");
  if (callsOutbound("void this.attemptDelivery(a, b, c);"))
    failures.push("a voided call was counted as a hold");
  if (!callsOutbound("registerAfterCommit(noop);\n await fetch(url);"))
    failures.push("the detach strip swallowed an awaited call beside it");
  if (signatureOf("export async function send(client: Wire, body: string) {\n", "send") === "")
    failures.push("an exported function signature was not extracted");
  if (methodBody("export async function ping(c: Wire) {\n  await fetch(u);\n}\n", "ping") === null)
    failures.push("an exported function body was not extracted");

  const paramWalk = makeReaches({
    directly: callsOutbound,
    maxHops: 2,
    strip: (body) => body,
  });
  const wireFile = join(SRC, "__self_test__", "wire.ts");
  const paramReached = paramWalk(
    "await client.deliver(payload);",
    new Map([["Wire", wireFile]]),
    { types: new Map([["client", "Wire"]]), source: "", file: wireFile },
    0,
    new Set(),
  );
  if (paramReached)
    failures.push("resolved a class file that does not exist, so the walk is not reading source");

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

  const { controllers, routes, holding, aiHolding } = scan();

  if (controllers < MIN_CONTROLLERS || routes < MIN_ROUTES) {
    console.error(
      `check-request-txn-outbound: resolved only ${controllers} controller(s) and ${routes} route(s) ` +
        `(floor ${MIN_CONTROLLERS}/${MIN_ROUTES}). The scan is broken, not the codebase.`,
    );
    process.exit(2);
  }

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ controllers, routes, holding, aiHolding }, null, 2));
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

  if (aiHolding.length > AI_CEILING) {
    console.error(
      `check-request-txn-outbound: ${aiHolding.length} route(s) await an AI provider while the request's ` +
        `tenant transaction is held, above the ceiling of ${AI_CEILING}. The fast tier is 30s and the ` +
        `standard tier 60s, on a pool of 10. Give the service three phases — read in a short ` +
        `runInTenantTransaction with an explicit orgId, call the provider in none, write in another — ` +
        `then add @NoTenantTransaction().`,
    );
    for (const entry of aiHolding) console.error(`  ${entry}`);
    process.exit(1);
  }

  if (aiHolding.length < AI_CEILING) {
    console.log(
      `check-request-txn-outbound: ${aiHolding.length} AI hold(s), below the ceiling of ${AI_CEILING}. ` +
        `Lower AI_CEILING to ${aiHolding.length} to hold the ground.`,
    );
  }

  console.log(
    `check-request-txn-outbound: ${routes} route(s) across ${controllers} controller(s); ` +
      `${holding.length} holding across an outbound call (frozen), ` +
      `${aiHolding.length} across an AI call (ceiling ${AI_CEILING}).`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
