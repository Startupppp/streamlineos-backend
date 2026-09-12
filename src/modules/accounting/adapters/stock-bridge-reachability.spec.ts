import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { MOVEMENT_GL_TREATMENT } from "./stock-movement-treatment";

/**
 * ACC-21's reachability guard.
 *
 * This pack found "built, and nothing routes to it" five times, once in its own
 * work. A bridge with a beautiful map and no caller would be the sixth, and it
 * would be invisible: every unit test above passes on a service nobody calls.
 *
 * So this asserts the wiring itself — that each document kind the bridge
 * declares is actually posted by a real inventory service, and that the
 * services which are supposed to post do.
 *
 * Retargeted at the inventory lane's split layout. Four of the seven posts
 * moved out of their service into a `lib/` file that the service imports
 * (`file` below), and the service that owns the flow is named as `via`, so
 * "the lib posts" and "a service reaches the lib" are both asserted. The
 * stock-mover sweep reads `lib/` files too: a sweep over `*.service.ts` alone
 * no longer sees most of the engine's callers.
 */

const INVENTORY = join(__dirname, "../../inventory");

const CALL_SITES: ReadonlyArray<{ file: string; kind: string; via?: string }> = [
  { file: "stock/lib/adjustment-posting.ts", kind: "adjustment", via: "stock/inv-stock-adjustments.service.ts" },
  { file: "stock/lib/transfer-complete.ts", kind: "transfer", via: "stock/inv-stock-transfers.service.ts" },
  { file: "counts/inv-cycle-counts.service.ts", kind: "cycle_count" },
  { file: "counts/lib/physical-audit-commands.ts", kind: "physical_audit", via: "counts/inv-physical-audits.service.ts" },
  { file: "quality/quality-inspections.service.ts", kind: "quality_inspection" },
  { file: "returns/lib/customer-return-post.ts", kind: "customer_return", via: "returns/customer-returns.service.ts" },
  { file: "returns/vendor-returns.service.ts", kind: "vendor_return" },
];

/** `this.glBridge.post(` in a service, `deps.glBridge.post(` or `glBridge.post(` in a lib. */
const BRIDGE_POST = /\b(?:this\.|deps\.)?glBridge\.post\(/;

function source(file: string): string {
  return readFileSync(join(INVENTORY, file), "utf8");
}

describe("the bridge is actually reached", () => {
  it.each(CALL_SITES)("$file posts as $kind", ({ file, kind }) => {
    const text = source(file);
    expect(text).toMatch(BRIDGE_POST);
    expect(text).toContain(`kind: "${kind}"`);
  });

  it.each(CALL_SITES.filter((site) => site.via))(
    "$via reaches the post in $file",
    ({ file, via }) => {
      const lib = file.split("/").pop()!.replace(/\.ts$/, "");
      expect(source(via!)).toMatch(new RegExp(`from "\\./lib/${lib}"`));
    },
  );

  it("posts on the caller's transaction at every call site", () => {
    /*
      §3.3/§4 of the contract. The post must take the movement's own
      transaction, passed explicitly — a call that omitted it would still work,
      because the request interceptor has one open, and would silently be
      relying on a guarantee this seam is supposed to make rather than borrow.
    */
    for (const { file } of CALL_SITES) {
      const text = source(file);
      const at = text.search(BRIDGE_POST);
      expect(at).toBeGreaterThan(-1);
      expect(text.slice(at, at + 700)).toMatch(/\n\s+tx,\n\s+\);/);
    }
  });

  it("gives every document kind exactly one call site", () => {
    /*
      One purpose per kind is what keeps `stock_move:{id}:{kind}` unique. Two
      services sharing a kind would put two documents from different tables
      into one key space — the ADR's double-post, rebuilt.
    */
    const kinds = CALL_SITES.map((c) => c.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
  });

  describe("no stock-moving file is quietly unaccounted for", () => {
    /*
      The list that started this ticket. Every file under inventory that drives
      the stock engine either posts through the bridge, posts directly, is
      named as deliberately silent with the reason, or is named as KNOWN AND
      UNPOSTED. A new one appears in none of those and fails.
    */
    const POSTS_DIRECTLY: Record<string, string> = {
      "purchase-orders/grn-receive.service.ts":
        "one-shot receive: PostingCommandService on the receipt tx, stock_move:{grnId}:receive",
      "purchase-orders/lib/grn-post-tx.ts":
        "two-phase receipt post: InventoryAccountingBridge.postJournalEntry on the receipt tx, the same stock_move:{grnId}:receive key",
      "sales-orders/so-ship.ts":
        "the shipment's movements; so-fulfillment.service.ts posts their COGS on the same tx, stock_move:{shipmentId}:ship",
      "stock/lib/transfer-dispatch.ts":
        "the dispatch leg; transfer-complete.ts posts every inv_transfer row of the transfer at completion",
    };
    const DELIBERATELY_SILENT: Record<string, string> = {
      "stock/inv-stock-reservations.service.ts": "reserves and releases; changes no value",
      "quality/quality-holds.service.ts": "moves stock between buckets; the business still owns it",
      "quality/lib/recall-create.ts": "quarantines for a recall; same reason (the recall service's movements since the split)",
      "quality/receipt-inspection.service.ts": "holds received goods in quarantine pending inspection; same reason",
      "import-export/import.service.ts": "opening stock, whose counterpart is the accountant's opening trial balance",
    };
    /*
      KNOWN AND UNPOSTED. Inventory-lane stock movers that change stock at a
      cost and have no `StockDocumentKind`, so nothing posts them. Listed so the
      gap is visible and each one's removal from this list is a deliberate act.
      The kernel's unposted-movements report counts their valued rows under
      `no_posting_path`. Each needs its own document kind (and, where it changes
      what the business owns, an accounting decision); none can reuse an
      existing kind without colliding with that kind's key.
    */
    const KNOWN_UNPOSTED: Record<string, string> = {
      "stock/transit-exit.service.ts":
        "stranded stock leaving transit (TRANSFER_IN, inv_transit_exit); cannot reuse `transfer`: completion already owns stock_move:{transferId}:transfer",
      "handling-units/handling-unit.service.ts":
        "moves between handling units (TRANSFER_OUT/IN, inv_handling_unit); nets to zero on one inventory account at carried cost",
      "kitting/lib/kit-build.ts":
        "kit assembly and disassembly (KIT_*, inv_kit_assembly / inv_kit_disassembly); nets to zero when cost is conserved",
      "stock-types/ownership.service.ts":
        "consignment ownership conversion (TRANSFER_OUT/IN across ownership, inv_ownership_conversion); changes what the business owns, so it needs an accounting decision, not only a kind",
      "putaway/putaway-complete.service.ts":
        "putaway from receiving to bin (TRANSFER and QUARANTINE legs, inv_putaway_task); nets to zero at carried cost",
      "sync/sync-batch.service.ts":
        "offline-sync adjustments (ADJUSTMENT_IN/OUT, offline-sync); change value and bypass the adjustment document that posts",
      "channels/lib/channel-snapshot-review.ts":
        "channel snapshot corrections (channel_snapshot_diff); change on-hand value with no document kind",
    };
    /*
      Cross-dock is the one unposted movement with no file of its own: its
      TRANSFER_OUT/IN legs (dock → outbound staging) are built by
      `buildCrossDockLegs` inside the receipt post, share the GRN's reference,
      and are not part of the receipt journal, which values the accepted lines
      once. They net to zero at the carried cost.
    */
    const UNPOSTED_LEGS_INSIDE_A_POSTED_DOCUMENT = {
      "purchase-orders/lib/grn-post-tx.ts": "buildCrossDockLegs",
    };

    const ENGINE_CALL = /\b\w*[eE]ngine\.(execute|executeInTx|executeMany|executeManyInTx)\(/;

    function movers(): string[] {
      const found: string[] = [];
      const walk = (dir: string, prefix = ""): void => {
        for (const entry of readdirSync(join(INVENTORY, dir), { withFileTypes: true })) {
          const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            if (entry.name === "__tests__" || entry.name === "stock-engine") continue;
            walk(join(dir, entry.name), rel);
            continue;
          }
          if (!entry.name.endsWith(".ts") || entry.name.endsWith(".spec.ts") || entry.name.endsWith(".d.ts")) continue;
          /*
            Any property name, not just `engine`, and any receiver: the first
            version matched `this.engine.` alone and missed a service that held
            the engine as `stockEngine`; the split layout passes it as `deps.engine`
            or a bare `engine` parameter.
          */
          if (ENGINE_CALL.test(readFileSync(join(INVENTORY, dir, entry.name), "utf8"))) found.push(rel);
        }
      };
      walk(".");
      return found.sort();
    }

    const found = movers();

    it("finds the engine's callers at all", () => {
      expect(found.length).toBeGreaterThan(12);
    });

    it("accounts for every one of them", () => {
      const accounted = new Set([
        ...CALL_SITES.map((c) => c.file),
        ...Object.keys(POSTS_DIRECTLY),
        ...Object.keys(DELIBERATELY_SILENT),
        ...Object.keys(KNOWN_UNPOSTED),
      ]);
      expect(found.filter((m) => !accounted.has(m))).toEqual([]);
    });

    it("keeps the known-unposted list honest: each entry still moves stock", () => {
      /*
        Anti-rot. A file that gains a posting path moves to CALL_SITES; one that
        stops moving stock leaves. Either way it must leave this list, or the
        list starts overstating the gap.
      */
      for (const file of Object.keys(KNOWN_UNPOSTED)) expect(found).toContain(file);
      for (const [file, marker] of Object.entries(UNPOSTED_LEGS_INSIDE_A_POSTED_DOCUMENT)) {
        expect(source(file)).toContain(marker);
      }
    });
  });
});

describe("the map has no unreachable branches", () => {
  it("names no counterpart role that no call site can ever produce", () => {
    /*
      The inverse of the check above: a role in the map that nothing routes to
      is a decision nobody can act on, and it would read as coverage.
    */
    const reachableTypes = [
      "ADJUSTMENT_IN", "ADJUSTMENT_OUT", "CYCLE_COUNT_GAIN", "CYCLE_COUNT_LOSS",
      "SCRAP", "CUSTOMER_RETURN", "VENDOR_RETURN", "TRANSFER_IN", "TRANSFER_OUT",
    ] as const;

    for (const type of reachableTypes) {
      expect(MOVEMENT_GL_TREATMENT[type].kind).toBe("counterpart");
    }
  });
});
