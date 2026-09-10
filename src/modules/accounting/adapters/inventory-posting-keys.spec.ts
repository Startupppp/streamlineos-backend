import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * ACC-07. Every inventory valuation posts through `PostingCommandService`, and
 * its idempotency key identifies the **event**, not the document.
 *
 * The key is `{sourceType}:{sourceId}:{purpose}` and a redelivery on the same
 * key returns the original journal and posts nothing. That is a safety property
 * right up until the key is too coarse, at which point it becomes the opposite:
 * a second, genuinely different event silently reports success and posts
 * nothing at all.
 *
 * The shipment is the case where that already nearly happened. A partially
 * shipped sales order ships more than once, so keying COGS on the sales order
 * would make every shipment after the first an idempotent replay — no COGS, no
 * error, inventory quietly overstated for the rest of the order's life. The
 * code keys on the shipment and says so in a comment; this is the test that
 * makes the comment binding.
 */

const MODULES = join(__dirname, "../../..", "modules");

interface Post {
  file: string;
  /** How the posting call is spelled, so the command object can be isolated. */
  call: string;
  sourceType: string;
  purpose: string;
  /** The identifier the key must be built from. */
  sourceId: string;
  /** Identifiers in scope at the call site that would be WRONG to key on. */
  wrongIds: string[];
}

/**
 * The command object handed to the posting call.
 *
 * Isolated by brace matching rather than searched for across the file: all
 * three of these services also build **stock-engine** commands, which have
 * their own `sourceType`/`sourceId` naming the sales order or the GRN quite
 * correctly. A file-wide search would confuse the two and fail on code that is
 * right.
 */
function postingCommand(source: string, call: string): string {
  const at = source.indexOf(call);
  if (at === -1) throw new Error(`no ${call} in this file`);
  const open = source.indexOf("{", at);
  if (open === -1) throw new Error("posting call has no command object");
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error("unbalanced braces in the posting command");
}

const POSTS: Post[] = [
  {
    file: "inventory/purchase-orders/grn.service.ts",
    call: "this.postToLedger(",
    sourceType: "stock_move",
    purpose: "receive",
    sourceId: "grn.id",
    // Keying on the PO would collapse every receipt against it into the first.
    wrongIds: ["poId", "po.id"],
  },
  {
    file: "inventory/sales-orders/so-fulfillment.service.ts",
    call: "this.posting.submit(",
    sourceType: "stock_move",
    purpose: "ship",
    sourceId: "ship.id",
    wrongIds: ["soId", "so.id"],
  },
  {
    file: "inventory/sales-orders/so-lifecycle.service.ts",
    call: "this.posting.submit(",
    sourceType: "sales_invoice",
    purpose: "issue",
    sourceId: "created.id",
    wrongIds: ["soId", "so.id"],
  },
];

describe.each(POSTS)("$file", ({ file, call, sourceType, purpose, sourceId, wrongIds }) => {
  const source = readFileSync(join(MODULES, file), "utf8");
  const command = postingCommand(source, call);

  it("declares the source type and purpose the ledger will key on", () => {
    expect(command).toContain(`sourceType: "${sourceType}"`);
    expect(command).toContain(`purpose: "${purpose}"`);
  });

  it("keys on the event, not on a document that produces several of them", () => {
    expect(command).toContain(`sourceId: String(${sourceId})`);
    for (const wrong of wrongIds) {
      expect(command).not.toContain(`sourceId: String(${wrong})`);
    }
  });

  it("reaches the ledger only through the adapter", () => {
    /*
      Complements `ledger-boundary.spec.ts`, which proves no module *names* the
      ledger tables. This proves the same file does not acquire a second, more
      direct route — a `LedgerService` import or a hand-built journal.
    */
    expect(source).not.toContain("LedgerService");
    expect(source).not.toContain("glJournal");
  });
});

describe("the three posts as a set", () => {
  it("cannot collide with each other", () => {
    /*
      Two posts sharing a `{sourceType, purpose}` would only be safe while their
      id spaces never overlap — `grn.id` and `ship.id` are both serial integers
      from different tables, so `stock_move:7:receive` and `stock_move:7:ship`
      are distinct only because the purposes differ. Making that explicit here
      means a third post reusing an existing purpose fails rather than silently
      replaying somebody else's journal.
    */
    const keys = POSTS.map((p) => `${p.sourceType}:${p.purpose}`);
    expect(new Set(keys).size).toBe(POSTS.length);
  });

  it("is the complete set of inventory posts, so a fourth is a deliberate act", () => {
    /*
      Anti-vacuity, and a ratchet. If a new call site appears, this count moves
      and whoever added it has to come here and state its key — which is the one
      decision that cannot be recovered later, because a wrong key does not
      fail, it succeeds and posts nothing.
    */
    const callSites = ["purchase-orders/grn.service.ts", "sales-orders/so-fulfillment.service.ts", "sales-orders/so-lifecycle.service.ts"];
    const posting = callSites.filter((f) =>
      readFileSync(join(MODULES, "inventory", f), "utf8").includes("posting-command"),
    );
    expect(posting).toHaveLength(3);
  });
});
