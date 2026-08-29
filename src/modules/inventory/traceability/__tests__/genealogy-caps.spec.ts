import { GENEALOGY_CAPS, genealogyQuerySchema } from "../dto/genealogy.schemas";
import { rowCap } from "../lib/genealogy-queries";
import { genealogyToCsv } from "../lib/genealogy-csv";
import type { GenealogyResult } from "../genealogy.types";

describe("genealogy caps", () => {
  it("defaults every cap rather than leaving the walk open", () => {
    const parsed = genealogyQuerySchema.parse({ lotId: "7" });
    expect(parsed).toMatchObject({
      lotId: 7,
      direction: "both",
      maxDepth: GENEALOGY_CAPS.maxDepth.default,
      maxNodes: GENEALOGY_CAPS.maxNodes.default,
      maxFanout: GENEALOGY_CAPS.maxFanout.default,
      includeReversed: false,
    });
  });

  it("refuses to widen a cap past its ceiling", () => {
    expect(() => genealogyQuerySchema.parse({ lotId: "1", maxDepth: "99" })).toThrow();
    expect(() => genealogyQuerySchema.parse({ lotId: "1", maxNodes: "5000" })).toThrow();
    expect(() => genealogyQuerySchema.parse({ lotId: "1", maxFanout: "5000" })).toThrow();
  });

  it("requires exactly one anchor", () => {
    expect(() => genealogyQuerySchema.parse({})).toThrow();
    expect(() => genealogyQuerySchema.parse({ lotId: "1", serialId: "2" })).toThrow();
  });

  it("reads includeReversed as a flag, not as truthiness", () => {
    // `z.coerce.boolean()` turns the string "false" into true, which would have
    // made the correction-aware default impossible to turn off honestly.
    expect(genealogyQuerySchema.parse({ lotId: "1", includeReversed: "false" }).includeReversed)
      .toBe(false);
    expect(genealogyQuerySchema.parse({ lotId: "1", includeReversed: "true" }).includeReversed)
      .toBe(true);
  });

  it("bounds one expansion by the frontier and by the node budget, whichever is smaller", () => {
    const query = genealogyQuerySchema.parse({ lotId: "1", maxNodes: "10", maxFanout: "5" });
    expect(rowCap(1, query)).toBe(7);
    expect(rowCap(3, query)).toBe(19);
    // 100 frontier nodes cannot ask for 100 x 6 rows when the answer may hold
    // only 10 nodes.
    expect(rowCap(100, query)).toBe(51);
  });
});

describe("genealogy CSV", () => {
  const graph: GenealogyResult = {
    anchor: {
      kind: "lot",
      id: 7,
      key: "lot:7",
      label: "LOT-A",
      productVariantId: 3,
      productName: "Traced goods",
      sku: "GEN-V",
    },
    caps: { direction: "both", maxDepth: 4, maxNodes: 100, maxFanout: 25 },
    nodes: [
      {
        key: "lot:7",
        kind: "lot",
        label: "LOT-A",
        depth: 0,
        lotId: 7,
        serialId: null,
        referenceType: null,
        referenceId: null,
        fanoutTruncated: false,
        unexplored: false,
      },
      {
        key: "inv_grn:2",
        kind: "document",
        label: "GRN-0002, first delivery",
        depth: 1,
        lotId: null,
        serialId: null,
        referenceType: "inv_grn",
        referenceId: "2",
        fanoutTruncated: true,
        unexplored: false,
      },
    ],
    edges: [
      {
        from: "inv_grn:2",
        to: "lot:7",
        kind: "MOVEMENT",
        direction: "backward",
        transactionId: 91,
        transactionType: "GRN",
        quantity: "100.0000",
        locationId: 5,
        occurredAt: "2026-06-01T00:00:00.000Z",
        reversed: false,
        closesCycle: false,
      },
    ],
    truncation: {
      complete: false,
      reasons: ["MAX_FANOUT"],
      depthReached: 1,
      nodeCount: 2,
      edgeCount: 1,
      unexploredNodes: 0,
      fanoutTruncatedNodes: ["inv_grn:2"],
    },
    corrections: { excludedFromWalk: true },
    warehouseScoped: false,
  };

  it("restates the truncation on every row", () => {
    const rows = genealogyToCsv(graph).trim().split("\n");
    expect(rows[0]).toContain("graph_complete,graph_truncation_reasons");
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatch(/,false,MAX_FANOUT$/);
  });

  it("quotes a label carrying a comma rather than splitting the row", () => {
    const rows = genealogyToCsv(graph).trim().split("\n");
    expect(rows[1]).toContain('"GRN-0002, first delivery"');
  });

  it("keeps a decimal quantity as text", () => {
    expect(genealogyToCsv(graph)).toContain("100.0000");
  });
});
