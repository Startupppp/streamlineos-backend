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
 *
 * Retargeted at the inventory lane's layout. The receipt and COGS posts live
 * in private helpers (`postReceipt`, `postCogs`) that are called inside the
 * transaction with `tx` as an argument, so each is checked twice: the call is
 * inside the transaction and hands it `tx`, and the helper hands that `tx` to
 * `PostingCommandService.submit`.
 */

const MODULES = join(__dirname, "../../..", "modules");

interface CallSite {
  file: string;
  /** The posting call to locate, inside the transaction. */
  call: string;
  /** How many transaction blocks the file has before the one that matters. */
  transactionIndex: number;
  /** How that call hands over the transaction. */
  txArgument: RegExp;
  /** The private method the call delegates to, when it is not the adapter itself. */
  helper?: string;
}

/** A trailing `tx` argument, on its own line or at the end of a one-liner. */
const TRAILING_TX = /\n\s*tx,\n\s*\)?$|\btx,?\s*$/;

const CALL_SITES: CallSite[] = [
  {
    file: "inventory/purchase-orders/grn-receive.service.ts",
    call: "this.postReceipt(",
    transactionIndex: 0,
    txArgument: /^this\.postReceipt\(orgId, userId, tx,/,
    helper: "postReceipt",
  },
  {
    file: "inventory/sales-orders/so-fulfillment.service.ts",
    call: "this.postCogs(",
    transactionIndex: 1,
    txArgument: /^this\.postCogs\(tx,/,
    helper: "postCogs",
  },
  {
    file: "inventory/sales-orders/so-lifecycle.service.ts",
    call: "this.posting.submit(",
    transactionIndex: 2,
    txArgument: TRAILING_TX,
  },
];

/**
 * The `[start, end)` span of the nth `db.transaction(` call's arguments.
 *
 * Paren matching rather than brace matching, because two of these
 * transactions are expression-bodied arrows into `runIdempotent(tx, …, { command
 * }, async () => { … })`: the first brace after the marker is the claim's
 * metadata object, and a brace-matched "body" would stop there, a line before
 * the post it is meant to contain.
 */
function transactionBody(source: string, index: number): [number, number] {
  const marker = "db.transaction(";
  let from = 0;
  for (let seen = 0; ; seen += 1) {
    const at = source.indexOf(marker, from);
    if (at === -1) throw new Error(`no db.transaction( number ${index} in this file`);
    if (seen === index) {
      const open = at + marker.length - 1;
      let depth = 0;
      for (let i = open; i < source.length; i += 1) {
        if (source[i] === "(") depth += 1;
        else if (source[i] === ")") {
          depth -= 1;
          if (depth === 0) return [open, i];
        }
      }
      throw new Error("unbalanced parentheses in the transaction call");
    }
    from = at + marker.length;
  }
}

/** The text of a call from its name up to (not including) the first `);` after it. */
function callArguments(text: string, call: string, from = 0): string {
  const at = text.indexOf(call, from);
  if (at === -1) throw new Error(`no ${call}`);
  return text.slice(at, text.indexOf(");", at));
}

describe.each(CALL_SITES)("$file", ({ file, call, transactionIndex, txArgument, helper }) => {
  const source = readFileSync(join(MODULES, file), "utf8").replace(/\r\n/g, "\n");
  const [start, end] = transactionBody(source, transactionIndex);
  const body = source.slice(start, end);

  it("has exactly one posting call, and it is inside the stock transaction", () => {
    /*
      Anti-vacuity in both directions. Zero calls would make every assertion
      below pass over nothing; more than one would mean this test is checking a
      different call than the one that matters.
    */
    expect(source.split(call).length - 1).toBe(1);
    expect(body.split(call).length - 1).toBe(1);
    // And one adapter call in the file, wherever it sits.
    expect(source.split("this.posting.submit(").length - 1).toBe(1);
  });

  it("hands the posting call the transaction, not the ambient connection", () => {
    /*
      The argument is what makes the guarantee this seam's own. A call inside
      the block that still omitted `tx` would post on `this.db`, which resolves
      to whatever transaction happens to be ambient — or to the pool, when there
      is none.
    */
    expect(callArguments(body, call)).toMatch(txArgument);
  });

  if (helper) {
    it(`passes that transaction on from ${helper} to the adapter`, () => {
      const declared = source.indexOf(`private async ${helper}(`);
      expect(declared).toBeGreaterThan(-1);
      const args = callArguments(source, "this.posting.submit(", declared);
      expect(args).toMatch(TRAILING_TX);
    });
  }

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

describe("the inventory lane's bridge hands the transaction all the way down", () => {
  /*
    The two-phase goods receipt and landed-cost apply post through
    `InventoryAccountingBridge.postJournalEntry`, whose `tx` is required. Each
    link of that chain is a place the transaction could be dropped.
  */
  const INVENTORY = join(MODULES, "inventory");
  const read = (file: string) => readFileSync(join(INVENTORY, file), "utf8").replace(/\r\n/g, "\n");

  it.each([
    ["purchase-orders/lib/grn-post-tx.ts", "postReceiptJournal("],
    ["purchase-orders/lib/receipt-journal.ts", "bridge.postJournalEntry("],
    ["landed-cost/landed-cost-apply.service.ts", "await postLandedCostJournal("],
    ["landed-cost/lib/landed-cost-journal.ts", "deps.accounting.postJournalEntry("],
    ["stock-engine/accounting-bridge.ts", "this.posting.submit("],
  ])("%s passes tx on at %s", (file, call) => {
    expect(callArguments(read(file), call)).toMatch(TRAILING_TX);
  });

  it("rethrows every rejection except the opt-out", () => {
    const bridge = read("stock-engine/accounting-bridge.ts");
    const swallowed = [...bridge.matchAll(/error\.code === "([A-Z_]+)"/g)].map((m) => m[1]);
    expect(swallowed).toEqual(["BOOK_NOT_ENABLED"]);
  });
});

describe("the contract this implements", () => {
  it("is checked in beside the code, not only in a commit message", () => {
    const contract = readFileSync(
      join(__dirname, "../../../..", "docs/inventory-gl-contract.md"),
      "utf8",
    ).replace(/\r\n/g, "\n");
    expect(contract).toContain("Atomicity is inherited, not declared");
    /* The decision ACC-05 implements, and the one it rejected. */
    expect(contract).toContain("There is no\n> `pending_accounting` state");
  });
});
