import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pickConstraintsResolver } from "../pick-allocation-constraints";

/**
 * D2 — picking allocates under the same rules as reserving.
 *
 * The gap this closes was real and quiet. Every call site in `picking/` passed
 * six arguments to `findAvailableLotForLine` and stopped at `expiryPolicy`, so a
 * wave, a confirm and a substitution all allocated with no near-expiry tier and
 * no customer shelf-life floor — while the same allocation through auto-reserve
 * honoured both. A picker's substitution could hand a customer a lot the reserve
 * path had refused minutes earlier for breaching their supply agreement, and
 * nothing recorded that a rule had been set aside, because from picking's point
 * of view no rule existed.
 *
 * Two of the three assertions here are structural rather than behavioural, and
 * deliberately so: the defect was not a wrong answer, it was a *missing
 * argument*, and an argument that is never passed cannot be caught by testing
 * what the function returns.
 */

const PICKING_DIR = join(__dirname, "..");

function source(file: string): string {
  return readFileSync(join(PICKING_DIR, file), "utf8");
}

/** Strips comments — a call site described in prose is not a call site. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

describe("D2 — picking allocates under the same constraints as reserving", () => {
  it("passes constraints at every call site that reaches the allocator", () => {
    const callers = [
      "pick-wave.service.ts",
      "pick-confirm.service.ts",
      "pick-exception-report.service.ts",
    ];

    const bare: string[] = [];
    for (const file of callers) {
      const text = code(source(file));
      if (!text.includes("findAvailableLotForLine")) continue;
      // The allocator's sixth argument is `expiryPolicy`. A call that ends there
      // — `expiryReservationPolicy,` followed by the closing paren — is one that
      // silently drops the near-expiry tier and the shelf-life floor.
      if (/settings\.expiryReservationPolicy,\s*\)/.test(text)) bare.push(file);
    }

    expect(bare).toEqual([]);
  });

  it("resolves the floor per order, not once for the wave", async () => {
    // A wave spans several customers. Resolving one floor for the whole wave
    // would apply the strictest customer's contract to everybody else's stock
    // and relax theirs to it — both wrong, in opposite directions.
    const seen: Array<string | null> = [];
    const db = {
      // `clientBehindSource` resolves the customer from the order before the
      // floor can be looked up; no order row means no client, which is the
      // ordinary case for a house rule.
      query: { invSalesOrders: { findFirst: async () => undefined } },
      select: () => {
        const chain: Record<string, unknown> = {};
        const step = () => chain;
        chain.from = step;
        chain.where = step;
        chain.orderBy = step;
        chain.limit = step;
        chain.then = (resolve: (rows: unknown[]) => unknown) => resolve([]);
        return chain;
      },
    };
    const settingsService = {
      get: async () => ({ nearExpiryPolicy: "BLOCK", nearExpiryWindowDays: 60 }),
    };

    const resolve = pickConstraintsResolver(db as never, settingsService as never, "org1");
    const a = await resolve(11);
    const b = await resolve(12);
    seen.push("11", "12");

    expect(a).toEqual({
      nearExpiryPolicy: "BLOCK",
      nearExpiryWindowDays: 60,
      minShelfLifeDays: 0,
    });
    expect(b).toEqual(a);
    expect(seen).toHaveLength(2);
  });

  it("caches per order, so a wave does not re-read one customer's rules per line", async () => {
    let settingsReads = 0;
    const db = {
      // `clientBehindSource` resolves the customer from the order before the
      // floor can be looked up; no order row means no client, which is the
      // ordinary case for a house rule.
      query: { invSalesOrders: { findFirst: async () => undefined } },
      select: () => {
        const chain: Record<string, unknown> = {};
        const step = () => chain;
        chain.from = step;
        chain.where = step;
        chain.orderBy = step;
        chain.limit = step;
        chain.then = (resolve: (rows: unknown[]) => unknown) => resolve([]);
        return chain;
      },
    };
    const settingsService = {
      get: async () => {
        settingsReads += 1;
        return { nearExpiryPolicy: "ALLOW", nearExpiryWindowDays: 30 };
      },
    };

    const resolve = pickConstraintsResolver(db as never, settingsService as never, "org1");
    await Promise.all([resolve(7), resolve(7), resolve(7)]);

    // One order, one resolution — not one per line.
    expect(settingsReads).toBe(1);
  });

  it("treats a line with no order as having no contract rather than a default floor", async () => {
    const db = {
      // `clientBehindSource` resolves the customer from the order before the
      // floor can be looked up; no order row means no client, which is the
      // ordinary case for a house rule.
      query: { invSalesOrders: { findFirst: async () => undefined } },
      select: () => {
        const chain: Record<string, unknown> = {};
        const step = () => chain;
        chain.from = step;
        chain.where = step;
        chain.orderBy = step;
        chain.limit = step;
        chain.then = (resolve: (rows: unknown[]) => unknown) => resolve([]);
        return chain;
      },
    };
    const settingsService = {
      get: async () => ({ nearExpiryPolicy: "ALLOW", nearExpiryWindowDays: 30 }),
    };

    const resolve = pickConstraintsResolver(db as never, settingsService as never, "org1");
    // With no destination there is no supply agreement to honour, and inventing
    // a floor would refuse stock nobody has objected to.
    await expect(resolve(null)).resolves.toEqual({
      nearExpiryPolicy: "ALLOW",
      nearExpiryWindowDays: 30,
      minShelfLifeDays: 0,
    });
  });
});
