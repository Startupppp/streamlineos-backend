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
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const INVENTORY_ROOT = join(__dirname, "..");

function controllerPaths(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith(".controller.ts")) found.push(path);
    }
  };
  walk(INVENTORY_ROOT);
  return found.sort();
}

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
  for (const path of controllerPaths()) {
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

/**
 * The work order's minimum set, as `file::handler`. Anything here must take a
 * key. The general check below covers everything else, present and future.
 */
const MUST_TAKE_A_KEY: ReadonlyArray<[string, string]> = [
  ["stock/inv-stock.controller.ts", "createReservation"],
  ["stock/inv-stock.controller.ts", "releaseReservation"],
  ["stock/inv-stock.controller.ts", "createOpeningBalance"],
  ["stock/inv-stock-transfers.controller.ts", "reserveTransfer"],
  ["stock/inv-stock-transfers.controller.ts", "dispatchTransfer"],
  ["stock/inv-stock-transfers.controller.ts", "completeTransfer"],
  ["stock/inv-stock-transfers.controller.ts", "cancelTransfer"],
  ["stock/inv-stock-adjustments.controller.ts", "createAdjustment"],
  ["stock/inv-stock-adjustments.controller.ts", "approveAdjustment"],
  ["stock/inv-stock-adjustments.controller.ts", "postAdjustment"],
  ["sales-orders/inv-sales-orders.controller.ts", "confirm"],
  ["sales-orders/inv-sales-orders.controller.ts", "reserve"],
  ["sales-orders/inv-sales-orders.controller.ts", "pick"],
  ["sales-orders/inv-sales-orders.controller.ts", "pack"],
  ["sales-orders/inv-sales-orders.controller.ts", "ship"],
  ["purchase-orders/inv-purchase-orders.controller.ts", "receiveGoods"],
  ["purchase-orders/grn.controller.ts", "reverse"],
  // Added after review: this one posts engine movements and took no key at all,
  // so a retry raised a second recall document against the same lots. The
  // general check above cannot see it — a handler that never asks for a key has
  // nothing to drop — which is the limit of that check and the reason this list
  // exists beside it.
  ["quality/recalls.controller.ts", "create"],
];

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

  it("takes a key on every command in the work order's minimum set", () => {
    const present = new Set(
      handlersTakingAKey().map((h) => `${h.file.replace("modules/inventory/", "")}::${h.name}`),
    );
    const missing = MUST_TAKE_A_KEY.map(([file, name]) => `${file}::${name}`).filter(
      (key) => !present.has(key),
    );

    expect(missing).toEqual([]);
  });

  it("has one way to read the header, so the check cannot drift", () => {
    // Twenty handlers carried a hand-copied `if (!key) throw`, in three
    // different wordings, and the copies were what made the check separable
    // from the value in the first place.
    const handRolled = controllerPaths()
      .filter((path) => /@Headers\(\s*["']idempotency-key["']/.test(readFileSync(path, "utf8")))
      .map((path) => path.slice(path.indexOf("modules/inventory/")));

    expect(handRolled).toEqual([]);
  });
});
