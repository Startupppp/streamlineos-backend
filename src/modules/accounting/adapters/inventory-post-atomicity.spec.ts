import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * ACC-05. The journal must ride the stock movement's own transaction.
 *
 * `docs/inventory-gl-contract.md` §3.3 records what this replaces. The three
 * bridge call sites used to post *after* `await this.db.transaction(...)`
 * returned, and that was atomic anyway — because `TenantContextInterceptor`
 * wraps the whole HTTP handler in a transaction and `createTenantAwareDb`
 * proxies `this.db` onto it, so the inner call was a savepoint and a later
 * throw rolled everything back.
 *
 * Atomicity inherited that way is worth very little:
 *
 *   - it holds only for an HTTP caller under that interceptor, and fifteen
 *     controllers here already opt out with `@NoTenantTransaction()`;
 *   - a single `catch`-and-log at a call site erases it with no test failing;
 *   - nothing said it was true, so nobody maintaining these files knew.
 *
 * Passing the transaction explicitly makes it this seam's own guarantee. These
 * assertions are structural rather than a substring search: each file's
 * `db.transaction(` body is found by brace matching, and the posting call has
 * to be *inside* it. A regression that moves a post back out — the exact edit
 * that would restore the old shape — fails here.
 */

const MODULES = join(__dirname, "../../..", "modules");

interface CallSite {
  file: string;
  /** The posting call to locate. */
  call: string;
  /** How many transaction blocks the file has before the one that matters. */
  transactionIndex: number;
}

const CALL_SITES: CallSite[] = [
  {
    file: "inventory/purchase-orders/grn.service.ts",
    call: "this.postToLedger(",
    transactionIndex: 0,
  },
  {
    file: "inventory/sales-orders/so-fulfillment.service.ts",
    call: "this.posting.submit(",
    transactionIndex: 1,
  },
  {
    file: "inventory/sales-orders/so-lifecycle.service.ts",
    call: "this.posting.submit(",
    transactionIndex: 1,
  },
];

/** The `[start, end)` span of the nth `db.transaction(` callback body. */
function transactionBody(source: string, index: number): [number, number] {
  const marker = "db.transaction(";
  let from = 0;
  for (let seen = 0; ; seen += 1) {
    const at = source.indexOf(marker, from);
    if (at === -1) throw new Error(`no db.transaction( number ${index} in this file`);
    if (seen === index) {
      const open = source.indexOf("{", at);
      if (open === -1) throw new Error("transaction callback has no body");
      let depth = 0;
      for (let i = open; i < source.length; i += 1) {
        if (source[i] === "{") depth += 1;
        else if (source[i] === "}") {
          depth -= 1;
          if (depth === 0) return [open, i];
        }
      }
      throw new Error("unbalanced braces in transaction callback");
    }
    from = at + marker.length;
  }
}

describe.each(CALL_SITES)("$file", ({ file, call, transactionIndex }) => {
  const source = readFileSync(join(MODULES, file), "utf8");
  const [start, end] = transactionBody(source, transactionIndex);
  const body = source.slice(start, end);

  it("has exactly one posting call, and it is inside the stock transaction", () => {
    /*
      Anti-vacuity in both directions. Zero calls would make every assertion
      below pass over nothing; more than one would mean this test is checking a
      different call than the one that matters.
    */
    const total = source.split(call).length - 1;
    expect(total).toBe(1);

    const inside = body.split(call).length - 1;
    expect(inside).toBe(1);
  });

  it("hands the posting call the transaction, not the ambient connection", () => {
    /*
      The argument is what makes the guarantee this seam's own. A call inside
      the block that still omitted `tx` would post on `this.db`, which resolves
      to whatever transaction happens to be ambient — or to the pool, when there
      is none.
    */
    const at = body.indexOf(call);
    const args = body.slice(at, body.indexOf(");", at));
    expect(args).toMatch(/\n\s*tx,\n\s*\)?$|\btx,?\s*$/);
  });

  it("rethrows every rejection except the opt-out", () => {
    /*
      `BOOK_NOT_ENABLED` is the honest opt-out and is the only code allowed to
      be swallowed. Anything else must leave the transaction by throwing —
      catching and logging would commit the stock and lose the journal, and
      would look exactly like working code.
    */
    expect(source).toContain("BOOK_NOT_ENABLED");
    const swallowed = [...source.matchAll(/error\.code === "([A-Z_]+)"/g)].map((m) => m[1]);
    expect(new Set(swallowed)).toEqual(new Set(["BOOK_NOT_ENABLED"]));
  });
});

describe("the contract this implements", () => {
  it("is checked in beside the code, not only in a commit message", () => {
    const contract = readFileSync(
      join(__dirname, "../../../..", "docs/inventory-gl-contract.md"),
      "utf8",
    );
    expect(contract).toContain("Atomicity is inherited, not declared");
    /* The decision ACC-05 implements, and the one it rejected. */
    expect(contract).toContain("There is no\n> `pending_accounting` state");
  });
});
