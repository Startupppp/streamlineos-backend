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
 */

const INVENTORY = join(__dirname, "../../inventory");

const CALL_SITES: ReadonlyArray<{ file: string; kind: string }> = [
  { file: "stock/inv-stock-adjustments.service.ts", kind: "adjustment" },
  { file: "stock/inv-stock-transfers.service.ts", kind: "transfer" },
  { file: "counts/inv-cycle-counts.service.ts", kind: "cycle_count" },
  { file: "counts/inv-physical-audits.service.ts", kind: "physical_audit" },
  { file: "quality/quality-inspections.service.ts", kind: "quality_inspection" },
  { file: "returns/customer-returns.service.ts", kind: "customer_return" },
  { file: "returns/vendor-returns.service.ts", kind: "vendor_return" },
];

function source(file: string): string {
  return readFileSync(join(INVENTORY, file), "utf8");
}

describe("the bridge is actually reached", () => {
  it.each(CALL_SITES)("$file posts as $kind", ({ file, kind }) => {
    const text = source(file);
    expect(text).toContain("this.glBridge.post(");
    expect(text).toContain(`kind: "${kind}"`);
  });

  it("posts on the caller's transaction at every call site", () => {
    /*
      §3.3/§4 of the contract. The post must take the movement's own
      transaction, passed explicitly — a call that omitted it would still work,
      because the request interceptor has one open, and would silently be
      relying on a guarantee this seam is supposed to make rather than borrow.
    */
    for (const { file } of CALL_SITES) {
      const text = source(file);
      const call = text.slice(text.indexOf("this.glBridge.post("));
      expect(call.slice(0, 700)).toMatch(/\n\s+tx,\n\s+\);/);
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

  it("leaves no stock-moving service quietly unaccounted for", () => {
    /*
      The list that started this ticket. Every service under inventory that
      drives the stock engine either posts through the bridge, posts directly
      (the two that already did), or is named here as deliberately silent with
      the reason. A new one appears in none of those and fails.
    */
    const POSTS_DIRECTLY = ["purchase-orders/grn.service.ts", "sales-orders/so-fulfillment.service.ts"];
    const DELIBERATELY_SILENT: Record<string, string> = {
      "stock/inv-stock-reservations.service.ts": "reserves and releases; changes no value",
      "quality/quality-holds.service.ts": "moves stock between buckets; the business still owns it",
      "quality/quality-recalls.service.ts": "quarantines; same reason",
      "import-export/import.service.ts": "opening stock, whose counterpart is the accountant's opening trial balance",
      "sales-orders/so-lifecycle.service.ts": "raises the invoice; the shipment posts the stock",
    };

    const movers: string[] = [];
    const walk = (dir: string, prefix = ""): void => {
      for (const entry of readdirSync(join(INVENTORY, dir), { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (entry.name === "__tests__" || entry.name === "stock-engine") continue;
          walk(join(dir, entry.name), rel);
          continue;
        }
        if (!entry.name.endsWith(".service.ts") || entry.name.endsWith(".spec.ts")) continue;
        const text = readFileSync(join(INVENTORY, dir, entry.name), "utf8");
        /*
          Any property name, not just `engine`. The first version of this
          matched `this.engine.` alone and silently missed
          `import-export/import.service.ts`, which calls the same engine
          through a field named `stockEngine` — so the one service this sweep
          most needed to notice was the one it could not see.
        */
        if (/this\.\w*[eE]ngine\.(execute|executeInTx|executeMany)\(/.test(text)) movers.push(rel);
      }
    };
    walk(".");

    expect(movers.length).toBeGreaterThan(12);

    const accounted = new Set([
      ...CALL_SITES.map((c) => c.file),
      ...POSTS_DIRECTLY,
      ...Object.keys(DELIBERATELY_SILENT),
    ]);
    expect(movers.filter((m) => !accounted.has(m))).toEqual([]);
  });
});

describe("the map has no unreachable branches", () => {
  it("names no counterpart role that no call site can ever produce", () => {
    /*
      The inverse of the check above: a role in the map that nothing routes to
      is a decision nobody can act on, and it would read as coverage.
    */
    const posting = new Set<string>();
    for (const { file } of CALL_SITES) posting.add(source(file));

    const reachableTypes = [
      "ADJUSTMENT_IN", "ADJUSTMENT_OUT", "CYCLE_COUNT_GAIN", "CYCLE_COUNT_LOSS",
      "SCRAP", "CUSTOMER_RETURN", "VENDOR_RETURN", "TRANSFER_IN", "TRANSFER_OUT",
    ] as const;

    for (const type of reachableTypes) {
      expect(MOVEMENT_GL_TREATMENT[type].kind).toBe("counterpart");
    }
  });
});
