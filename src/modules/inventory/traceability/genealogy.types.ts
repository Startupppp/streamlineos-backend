/** D1. The shape of one bounded genealogy answer. */

export type GenealogyNodeKind = "lot" | "serial" | "document";

export type GenealogyDirection = "forward" | "backward" | "both";

export interface GenealogyNode {
  /** `lot:12` · `serial:7` · `inv_grn:41`. Stable within one answer. */
  key: string;
  kind: GenealogyNodeKind;
  label: string;
  /** Hops from the anchor. The anchor is 0. */
  depth: number;
  lotId: number | null;
  serialId: number | null;
  referenceType: string | null;
  referenceId: string | null;
  /**
   * Expansion out of this node hit the per-node fan-out cap, so the answer
   * shows some of what this node connects to, not all of it.
   */
  fanoutTruncated: boolean;
  /**
   * Discovered but never expanded — the depth or node cap stopped the walk
   * before this node's own edges were read.
   */
  unexplored: boolean;
}

export interface GenealogyEdge {
  from: string;
  to: string;
  kind: "MOVEMENT" | "CONTAINS";
  direction: Exclude<GenealogyDirection, "both">;
  transactionId: number | null;
  transactionType: string | null;
  /** Decimal(18,4) as text. Never a float. */
  quantity: string | null;
  locationId: number | null;
  occurredAt: string | null;
  /** A2 — this movement was reversed, or is itself the reversal. */
  reversed: boolean;
  /** The target was already in the answer: this edge closes a cycle. */
  closesCycle: boolean;
}

export type GenealogyTruncationReason =
  | "MAX_DEPTH"
  | "MAX_NODES"
  | "MAX_EDGES"
  | "MAX_FANOUT"
  | "WAREHOUSE_SCOPE";

export interface GenealogyResult {
  anchor: {
    kind: "lot" | "serial";
    id: number;
    key: string;
    label: string;
    productVariantId: number;
    productName: string | null;
    sku: string | null;
  };
  caps: {
    direction: GenealogyDirection;
    maxDepth: number;
    maxNodes: number;
    maxFanout: number;
  };
  nodes: GenealogyNode[];
  edges: GenealogyEdge[];
  /**
   * A truncated answer must look truncated. `complete: false` plus at least one
   * reason is the only honest way to serve a partial recall trace.
   */
  truncation: {
    complete: boolean;
    reasons: GenealogyTruncationReason[];
    depthReached: number;
    nodeCount: number;
    edgeCount: number;
    /** Nodes discovered but never expanded, because a cap stopped the walk. */
    unexploredNodes: number;
    /** Node keys whose own expansion was cut short by the fan-out cap. */
    fanoutTruncatedNodes: string[];
  };
  corrections: {
    /** Reversed movements and their reversals were left out of the walk. */
    excludedFromWalk: boolean;
  };
  /** The caller is scoped to a subset of warehouses, so the graph is partial. */
  warehouseScoped: boolean;
}
