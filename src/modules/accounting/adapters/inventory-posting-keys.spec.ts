import { readdirSync, readFileSync, statSync } from "node:fs";
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
 *
 * Retargeted at the inventory lane's layout: the one-shot receipt posts from
 * `grn-receive.service.ts` (keyed on `receipt.grnId`), and COGS from
 * `so-fulfillment.service.ts`'s `postCogs` (keyed on `shipped.shipmentId`).
 * The two-phase receipt and landed cost post through
 * `InventoryAccountingBridge`, checked in their own block below.
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
    file: "inventory/purchase-orders/grn-receive.service.ts",
    call: "this.posting.submit(",
    sourceType: "stock_move",
    purpose: "receive",
    sourceId: "receipt.grnId",
    // Keying on the PO would collapse every receipt against it into the first.
    wrongIds: ["poId", "po.id"],
  },
  {
    file: "inventory/sales-orders/so-fulfillment.service.ts",
    call: "this.posting.submit(",
    sourceType: "stock_move",
    purpose: "ship",
    sourceId: "shipped.shipmentId",
    wrongIds: ["soId", "so.id"],
  },
  {
    file: "inventory/sales-orders/so-lifecycle.service.ts",
    call: "this.posting.submit(",
    sourceType: "sales_invoice",
    /*
      Shared with `modules/invoices`, deliberately. Both write into the same
      `invoices` table and the same serial id space; two purposes gave one
      document two idempotency keys and made a double-post reachable through a
      status round-trip. See `docs/adr-legacy-invoices-vs-ar.md`.
    */
    purpose: "post",
    sourceId: "created.id",
    wrongIds: ["soId", "so.id"],
  },
];

describe.each(POSTS)("$file", ({ file, call, sourceType, purpose, sourceId, wrongIds }) => {
  const source = readFileSync(join(MODULES, file), "utf8").replace(/\r\n/g, "\n");
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

describe("the posts through InventoryAccountingBridge", () => {
  const INVENTORY = join(MODULES, "inventory");
  const read = (file: string) => readFileSync(join(INVENTORY, file), "utf8").replace(/\r\n/g, "\n");
  const bridge = read("stock-engine/accounting-bridge.ts");

  it("hands the ledger stock_move with the draft's event as the purpose", () => {
    const command = postingCommand(bridge, "this.posting.submit(");
    expect(command).toContain('sourceType: "stock_move"');
    expect(command).toContain("sourceId: draft.sourceId");
    expect(command).toContain("purpose: draft.sourceEvent");
  });

  it("keys the two-phase receipt exactly as the one-shot receive, so one GRN posts once", () => {
    const receipt = read("purchase-orders/lib/receipt-journal.ts");
    expect(receipt).toContain('sourceType: "inv_grn"');
    expect(receipt).toContain('sourceEvent: "receive"');
    expect(receipt).toContain("sourceId: String(grn.id)");
    // grn.id and receipt.grnId are the same inv_grns id.
    expect(POSTS[0]!.purpose).toBe("receive");
  });

  it("keys landed cost on the voucher, under a purpose of its own", () => {
    const landed = read("landed-cost/lib/landed-cost-journal.ts");
    expect(landed).toContain('sourceEvent: "landed_cost"');
    expect(landed).toContain("sourceId: String(voucherId)");
    expect(landed).not.toContain("sourceId: String(grn");
  });
});

describe("the inventory posts as a set", () => {
  it("cannot collide with each other", () => {
    /*
      Two posts sharing a `{sourceType, purpose}` would only be safe while their
      id spaces never overlap — `grn.id` and `ship.id` are both serial integers
      from different tables, so `stock_move:7:receive` and `stock_move:7:ship`
      are distinct only because the purposes differ. The bridge's `receive`
      deliberately shares the one-shot receive's key (same event); its
      `landed_cost` must be new.
    */
    const keys = POSTS.map((p) => `${p.sourceType}:${p.purpose}`);
    expect(new Set(keys).size).toBe(POSTS.length);
    expect(keys).not.toContain("stock_move:landed_cost");
  });

  it("is the complete set of inventory files that reach the adapter, so a fifth is a deliberate act", () => {
    /*
      A ratchet over the whole inventory tree, not a list checked against
      itself. If a new file starts posting, this moves and whoever added it has
      to come here and state its key — the one decision that cannot be
      recovered later, because a wrong key does not fail, it succeeds and posts
      nothing.
    */
    const root = join(MODULES, "inventory");
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((entry) => {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) return entry === "__tests__" ? [] : walk(path);
        return path.endsWith(".ts") && !path.endsWith(".spec.ts") ? [path] : [];
      });
    const posting = walk(root)
      .filter((path) => readFileSync(path, "utf8").replace(/\r\n/g, "\n").includes("posting-command"))
      .map((path) => path.slice(root.length + 1).replaceAll("\\", "/"))
      .sort();
    expect(posting).toEqual([
      "purchase-orders/grn-receive.service.ts",
      "sales-orders/so-fulfillment.service.ts",
      "sales-orders/so-lifecycle.service.ts",
      "stock-engine/accounting-bridge.ts",
    ]);
  });
});

describe("every writer into the legacy invoices table shares one key", () => {
  /*
    ACC-18. `modules/invoices` and `inventory/sales-orders/so-lifecycle` both
    insert into the same `invoices` table and the same serial id space. They
    posted under different purposes — `post` and `issue` — so one document had
    two possible idempotency keys and the key could not deduplicate between
    them.

    See `docs/adr-legacy-invoices-vs-ar.md`.
  */
  const LEGACY_INVOICE_WRITERS = [
    "inventory/sales-orders/so-lifecycle.service.ts",
    "invoices/invoices-posting.service.ts",
  ];

  it("uses exactly one purpose across every writer", () => {
    const purposes = new Set<string>();
    for (const file of LEGACY_INVOICE_WRITERS) {
      const source = readFileSync(join(MODULES, file), "utf8").replace(/\r\n/g, "\n");
      const at = source.indexOf('sourceType: "sales_invoice"');
      expect(at).toBeGreaterThan(-1);
      const nearby = source.slice(Math.max(0, at - 1200), at + 2400);
      const purpose = /purpose:\s*"([a-z_]+)"/.exec(nearby)?.[1];
      expect(purpose).toBeDefined();
      purposes.add(purpose!);
    }

    expect(LEGACY_INVOICE_WRITERS).toHaveLength(2);
    expect([...purposes]).toEqual(["post"]);
  });

  it("keeps the rule written down where the next writer will look", () => {
    const adr = readFileSync(
      join(__dirname, "../../../..", "docs/adr-legacy-invoices-vs-ar.md"),
      "utf8",
    );
    expect(adr).toContain("sales_invoice:{invoices.id}:post");
    expect(adr).toContain("One document, one key.");
  });
});
