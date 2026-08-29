import { InvBarcodeService } from "../inv-barcode.service";

/**
 * E3 — the LASA warning reaches the person holding the box.
 *
 * `GET /inventory/products/variants/:variantId/pharmacy` returned look-alike /
 * sound-alike siblings and high-alert flags, and nothing called it. A picker does
 * not open a product page mid-walk — they scan. So the warning existed, was
 * tested, and reached nobody.
 *
 * For most features that is a wiring gap. For this one it is the whole point:
 * a look-alike/sound-alike warning that is never shown is not a safety control,
 * it is a record that somebody thought about safety. These assert it arrives on
 * the surface a person actually touches.
 */

function buildService(opts: {
  variant?: { id: number; sku: string; isActive: boolean; productId: number; name: string } | null;
  alerts?: Array<{ code: string; disposition: "WARN" | "ACKNOWLEDGE"; message: string }>;
}) {
  const variant = opts.variant === undefined ? { id: 5, sku: "AMX-500", isActive: true, productId: 1, name: "Amoxil" } : opts.variant;

  // A plain SKU barcode, not GS1 — the common case, and the path the first
  // implementation of this missed entirely.
  const db = {
    query: {
      invProductVariants: {
        findFirst: async () =>
          variant ? { ...variant, totalOnHand: "0.0000" } : undefined,
      },
      invLots: { findFirst: async () => undefined },
      invSerialNumbers: { findFirst: async () => undefined },
      invProducts: { findFirst: async () => undefined },
      invLocations: { findFirst: async () => undefined },
    },
    insert: () => ({ values: async () => undefined }),
    execute: async () => [],
    // `lookup` sums on-hand for whichever entity it resolved.
    select: () => {
      const chain: Record<string, unknown> = {};
      const step = () => chain;
      chain.from = step;
      chain.where = step;
      chain.innerJoin = step;
      chain.leftJoin = step;
      chain.groupBy = step;
      chain.limit = step;
      chain.then = (resolve: (rows: unknown[]) => unknown) => resolve([]);
      return chain;
    },
  };

  const pharmacy = {
    dispensingProfile: jest.fn(async () => ({
      safety: {
        alerts: opts.alerts ?? [],
        blocksDispense: false as const,
        acknowledgementRequired: (opts.alerts ?? []).some((a) => a.disposition === "ACKNOWLEDGE"),
      },
    })),
  };

  return {
    service: new InvBarcodeService(db as never, pharmacy as never),
    pharmacy,
  };
}

describe("E3 — a scan carries the pharmacy safety alerts", () => {
  it("puts a look-alike warning in the array the scanner already reads", async () => {
    const { service } = buildService({
      alerts: [
        {
          code: "LASA",
          disposition: "WARN",
          message: "Look-alike/sound-alike: Amoxil is easily confused with Amoxil DT",
        },
      ],
    });

    const result = await service.scan("org1", "8901234567890");

    expect(result.warnings).toContain(
      "Look-alike/sound-alike: Amoxil is easily confused with Amoxil DT",
    );
  });

  it("marks an acknowledge-level alert as needing confirmation rather than flattening it", async () => {
    // WARN and ACKNOWLEDGE are different instructions. Rendering both as plain
    // text loses the one that asks the operator to stop and confirm.
    const { service } = buildService({
      alerts: [{ code: "HIGH_ALERT", disposition: "ACKNOWLEDGE", message: "High-alert medicine" }],
    });

    const result = await service.scan("org1", "8901234567890");

    expect(result.warnings).toContain("Confirm before use: High-alert medicine");
  });

  it("adds nothing when the SKU has no alerts", async () => {
    const { service } = buildService({ alerts: [] });
    const result = await service.scan("org1", "8901234567890");
    expect(result.warnings).toEqual([]);
  });

  it("does not ask the catalogue about a code that resolved to no variant", async () => {
    // A scan of an unknown barcode has no SKU to be unsafe about, and asking
    // anyway would be a query per failed scan on the hottest path in the module.
    const { pharmacy, service } = buildService({ variant: null });
    await service.scan("org1", "nonsense");
    expect(pharmacy.dispensingProfile).not.toHaveBeenCalled();
  });

  it("never refuses the scan, whatever the alerts say", async () => {
    // `blocksDispense` is false by construction and a scan is not a dispense.
    // A safety warning that blocks the scanner turns a caution into an outage.
    const { service } = buildService({
      alerts: [{ code: "HIGH_ALERT", disposition: "ACKNOWLEDGE", message: "High-alert medicine" }],
    });
    await expect(service.scan("org1", "8901234567890")).resolves.toBeDefined();
  });
});
