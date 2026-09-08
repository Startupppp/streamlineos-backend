/**
 * A3 — no stock-affecting command can quietly lose its idempotency key.
 *
 * The defect this exists to prevent is not a missing header check. It is a
 * handler that *demands* the header, throws without it, and then calls its
 * service without passing it on — so the client is made to supply a key that
 * changes nothing, and a retried reserve creates a second ACTIVE reservation
 * holding the same stock twice. Three inventory routes shipped in that state
 * (`stock/reserve`, `transfers/:id/reserve`, and the sales-order pick, which
 * took no key at all and ran across three separate transactions).
 *
 * A reviewer cannot see that from a diff: the handler looks correct, because
 * the check and the value are separate things. So it is checked here instead,
 * against the real controller sources rather than a list somebody maintains.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  inventoryControllerPaths,
  isCovered,
  mutatingInventoryRoutes,
} from "./inventory-mutating-routes";
import {
  COMMAND_CLASSIFICATION,
  COMMAND_CLASS_RATIONALE,
} from "./inventory-command-classification";

const INVENTORY_ROOT = join(__dirname, "..");


/** The body of the method whose parameter list contains `at`. */
function enclosingMethodBody(source: string, at: number): string {
  const open = source.indexOf("{", source.indexOf(")", at));
  if (open === -1) return "";
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return source.slice(open);
}

interface Handler {
  file: string;
  name: string;
  /** The parameter the decorator is bound to, which is what the body must use. */
  parameter: string;
  body: string;
}

/**
 * The handler a `@IdempotencyKey()` sits inside.
 *
 * Found by scanning back to the nearest method signature at class indentation,
 * not by looking immediately behind the decorator: the key is rarely the first
 * parameter, and assuming it was silently reported every handler as "unknown"
 * — which made this file pass by matching nothing.
 */
const METHOD_SIGNATURE = /\n {2}(?:async )?([A-Za-z0-9_]+)\s*\(/g;

function handlersTakingAKey(): Handler[] {
  const out: Handler[] = [];
  for (const path of inventoryControllerPaths()) {
    const source = readFileSync(path, "utf8");
    const file = path.slice(path.indexOf("modules/inventory/"));

    const signatures: Array<{ at: number; name: string }> = [];
    for (const m of source.matchAll(METHOD_SIGNATURE))
      signatures.push({ at: m.index, name: m[1] ?? "unknown" });

    let from = 0;
    for (;;) {
      const at = source.indexOf("@IdempotencyKey()", from);
      if (at === -1) break;
      from = at + 1;

      const owner = [...signatures].reverse().find((s) => s.at < at);
      const parameter =
        /@IdempotencyKey\(\)\s*([A-Za-z0-9_]+)\s*:/.exec(source.slice(at, at + 120))?.[1] ??
        "idempotencyKey";

      out.push({
        file,
        name: owner?.name ?? "unknown",
        parameter,
        body: enclosingMethodBody(source, at),
      });
    }
  }
  return out;
}



const routes = mutatingInventoryRoutes();

describe("A3 — idempotency coverage across inventory commands", () => {
  it("never demands a key and then drops it", () => {
    // The general rule, with no list to maintain: a handler that makes the
    // client supply a key must do something with it. An unused key is worse
    // than no key, because the client believes it is protected.
    const dropped = handlersTakingAKey()
      // Against the parameter's own name. Matching a fixed `idempotencyKey`
      // reported three handlers as dropping a key they in fact passed on,
      // because their parameter was called `idempotencyKeyHeader`.
      .filter((h) => !new RegExp(`\\b${h.parameter}\\b`).test(h.body.slice(h.body.indexOf("{"))))
      .map((h) => `${h.file}::${h.name}`);

    expect(dropped).toEqual([]);
  });

  it("walks the whole surface, so a broken walk cannot pass as zero violations", () => {
    // Every assertion below is a filter over `routes`. A walk that matched
    // nothing would report an empty violation list and read as a pass, which
    // is how the sibling placement ratchet nearly shipped inert. The numbers
    // are floors, not targets: they are the measured population minus room to
    // delete a controller without tripping the floor.
    expect(inventoryControllerPaths().length).toBeGreaterThan(60);
    expect(routes.length).toBeGreaterThan(200);
    expect(routes.filter((r) => r.takesClientKey).length).toBeGreaterThan(50);
    // The second coverage mechanism has its own floor. Without one, a decorator
    // walk that matched nothing would report every fenced route as unfenced and
    // the assertion below would pass by having no fenced routes to check.
    expect(routes.filter((r) => r.carriesInterceptorFence).length).toBeGreaterThan(10);
    expect(routes.filter((r) => r.carriesInterceptorFence && r.fenceCommand === null)).toEqual([]);
    expect(routes.filter((r) => r.commands.length > 0).length).toBeGreaterThan(45);
    // The census keys the classification on `<file>::<handler>`. Two routes
    // sharing an id would let one of them inherit the other's classification.
    expect(new Set(routes.map((r) => r.id)).size).toBe(routes.length);
  });

  it("takes a client key on every route that calls a command expecting one", () => {
    // The derived replacement for `MUST_TAKE_A_KEY`, which was eighteen handler
    // names typed out by hand. A service method whose signature declares an
    // `idempotencyKey` is a command that intends to be replay-safe, and the
    // only honest source for that value is the caller's header — a handler that
    // reaches one without `@IdempotencyKey()` is either inventing a key or
    // passing a constant. This is not a restatement of the old list: it is what
    // would have caught `quality/recalls.controller::create`, which posted
    // engine movements with no key at all, on its first run rather than in
    // review. `RecallsService.create` declares the parameter.
    const missing = routes
      .filter((r) => !r.takesClientKey && r.commands.length > 0)
      .map((r) => `${r.id} -> ${r.commands.join(", ")}`);

    expect(missing).toEqual([]);
  });

  it("classifies every mutating route, so a new one cannot land unexamined", () => {
    // The whole point of T17. Taking a key is its own classification and is
    // read off the source. Everything else has to be argued for in
    // COMMAND_CLASSIFICATION, and an unclassified route is a failure rather
    // than an absence — the shape `NO_DATA_ROUTES` and `CANNOT_INVALIDATE` use.
    // Covered by EITHER mechanism. Reading only `takesClientKey` here is what
    // forced an argument out of routes the interceptor already fences, and the
    // arguments written to satisfy it were wrong.
    const classified = new Set(COMMAND_CLASSIFICATION.map((c) => c.route));
    const unclassified = routes
      .filter((r) => !isCovered(r) && !classified.has(r.id))
      .map((r) => `${r.verb} ${r.path} (${r.id})`);

    expect(unclassified).toEqual([]);
  });

  it("keeps every classification pointed at a route that still exists", () => {
    // An entry for a handler that has been renamed or deleted is a hole that
    // reads as a rule, and it is how a list of this size rots. The same
    // argument the migration exclusions and CANNOT_INVALIDATE make.
    const live = new Set(routes.map((r) => r.id));
    const stale = COMMAND_CLASSIFICATION.filter((c) => !live.has(c.route)).map((c) => c.route);

    expect(stale).toEqual([]);
  });

  it("does not classify a route that takes a key, because taking one is the answer", () => {
    // A keyed route with an entry here would mean the table had started to
    // duplicate the source instead of exempting from it — the drift that turns
    // an exemption list back into a coverage list.
    const keyed = new Set(routes.filter((r) => r.takesClientKey).map((r) => r.id));
    const redundant = COMMAND_CLASSIFICATION.filter((c) => keyed.has(c.route)).map((c) => c.route);

    expect(redundant).toEqual([]);
  });

  it("gives every classification a reason somebody can read", () => {
    const unreasoned = COMMAND_CLASSIFICATION.filter((c) => c.why.length < 60).map((c) => c.route);
    expect(unreasoned).toEqual([]);
    for (const rationale of Object.values(COMMAND_CLASS_RATIONALE))
      expect(rationale.length).toBeGreaterThan(120);
  });

  it("has no route left that a retry duplicates", () => {
    // This was a bounded finding — 40, then 37 once T23 could see the second
    // coverage mechanism. It is now zero, and zero by fencing rather than by
    // reclassification: every one of those routes carries `@Idempotent`, so the
    // interceptor answers the retry instead of the handler running twice.
    //
    // The bound is an equality now, in both directions. A route that regresses
    // to duplicating fails, and so does one somebody quietly reclassifies into
    // this bucket instead of fixing.
    const findings = COMMAND_CLASSIFICATION.filter(
      (c) => c.commandClass === "DUPLICATES_ON_RETRY",
    ).map((c) => c.route);

    expect(findings).toEqual([]);
    // Anti-vacuity: `findings` is empty because the table no longer holds those
    // routes, not because the table itself vanished or the walk broke. The
    // fenced floor in the surface test guards the other half.
    expect(COMMAND_CLASSIFICATION.length).toBeGreaterThan(100);
    expect(routes.filter((r) => r.carriesInterceptorFence).length).toBeGreaterThan(45);
  });

  it("does not call a fenced route one that duplicates, because the fence answers the retry", () => {
    // The correction T23 exists for. `DUPLICATES_ON_RETRY` asserts something
    // specific and checkable — "a retry raises a second document" — and for a
    // route carrying `@Idempotent` that is false: the global interceptor claims
    // the key, stores the response and replays it, so the second call never
    // reaches the handler.
    //
    // Three routes were recorded that way (`purchase-orders::create`,
    // `projects::create`, `projects::addRequirement`), each with a reason
    // written by hand describing the duplicate in detail. The detail is what
    // made them convincing. The census could not have contradicted them,
    // because it only ever read `@IdempotencyKey()`.
    const fenced = new Map(
      routes.filter((r) => r.carriesInterceptorFence).map((r) => [r.id, r.fenceCommand]),
    );
    const contradicted = COMMAND_CLASSIFICATION.filter(
      (c) => c.commandClass === "DUPLICATES_ON_RETRY" && fenced.has(c.route),
    ).map((c) => `${c.route} is fenced by @Idempotent("${fenced.get(c.route)}")`);

    expect(contradicted).toEqual([]);
  });

  it("does not make a read-only POST ask for a key it has no use for", () => {
    // D4. `recalls/simulate` is a POST purely because a recall selection does
    // not fit in a query string; it writes nothing, so there is no effect to
    // replay and nothing a key would protect. Demanding one anyway is the
    // mirror image of the defect above — a key the client is made to mint and
    // the server cannot use — and it would quietly turn every re-simulate into
    // a 409 while the first lease was live.
    const source = readFileSync(
      join(INVENTORY_ROOT, "quality", "recalls.controller.ts"),
      "utf8",
    );
    const simulate = source.slice(source.indexOf('@Post("simulate")'), source.indexOf("@Post()"));

    expect(simulate).toContain("simulate(");
    expect(simulate).not.toContain("@IdempotencyKey()");
  });

  it("has one way to read the header, so the check cannot drift", () => {
    // Twenty handlers carried a hand-copied `if (!key) throw`, in three
    // different wordings, and the copies were what made the check separable
    // from the value in the first place.
    const handRolled = inventoryControllerPaths()
      .filter((path) => /@Headers\(\s*["']idempotency-key["']/.test(readFileSync(path, "utf8")))
      .map((path) => path.slice(path.indexOf("modules/inventory/")));

    expect(handRolled).toEqual([]);
  });
});
