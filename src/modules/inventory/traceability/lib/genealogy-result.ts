import type { Db } from "../../../../db/drizzle.module";
import type { GenealogyQueryInput } from "../dto/genealogy.schemas";
import type {
  GenealogyEdge,
  GenealogyNode,
  GenealogyResult,
  GenealogyTruncationReason,
} from "../genealogy.types";
import { resolveDocumentLabels, resolveLotLabels, resolveSerialLabels } from "./genealogy-labels";
import type { AnchorItem, DocumentRef } from "./genealogy-queries";

/**
 * Business numbers for every node in one answer, resolved once at the end.
 *
 * "Show names, never raw IDs" applies to a graph as much as to a table, and the
 * walk itself has no business reading label columns it never filters on. The
 * lookups are bounded by `maxNodes`, so this is a fixed handful of small
 * queries however wide the graph turned out.
 */
export async function applyGenealogyLabels(
  db: Db,
  orgId: string,
  nodes: Map<string, GenealogyNode>,
): Promise<void> {
  const lotIds: number[] = [];
  const serialIds: number[] = [];
  const documents: DocumentRef[] = [];
  for (const node of nodes.values()) {
    if (node.kind === "lot" && node.lotId != null) lotIds.push(node.lotId);
    else if (node.kind === "serial" && node.serialId != null) serialIds.push(node.serialId);
    else if (node.referenceType != null && node.referenceId != null)
      documents.push({ referenceType: node.referenceType, referenceId: node.referenceId });
  }

  const [lotLabels, serialLabels, documentLabels] = await Promise.all([
    resolveLotLabels(db, orgId, lotIds),
    resolveSerialLabels(db, orgId, serialIds),
    resolveDocumentLabels(db, orgId, documents),
  ]);

  for (const node of nodes.values()) {
    if (node.kind === "lot" && node.lotId != null)
      node.label = lotLabels.get(node.lotId) ?? node.label;
    else if (node.kind === "serial" && node.serialId != null)
      node.label = serialLabels.get(node.serialId) ?? node.label;
    else if (node.kind === "document") node.label = documentLabels.get(node.key) ?? node.label;
  }
}

export interface RenderInput {
  anchor: AnchorItem;
  anchorKey: string;
  query: GenealogyQueryInput;
  nodes: Map<string, GenealogyNode>;
  edges: Map<string, GenealogyEdge>;
  reasons: Set<GenealogyTruncationReason>;
  warehouseScoped: boolean;
}

/**
 * The answer, with the caps it was walked under attached to it.
 *
 * `complete` is false the moment any reason was recorded. It is stated
 * positively so a consumer that reads nothing else still cannot mistake a
 * partial trace for an exhaustive one.
 */
export function renderGenealogy(input: RenderInput): GenealogyResult {
  const { anchor, anchorKey, query, nodes, edges, reasons, warehouseScoped } = input;
  const nodeList = [...nodes.values()].sort(
    (a, b) => a.depth - b.depth || a.key.localeCompare(b.key),
  );
  const truncationReasons = [...reasons];
  return {
    anchor: {
      kind: anchor.kind,
      id: anchor.id,
      key: anchorKey,
      label: anchor.label,
      productVariantId: anchor.productVariantId,
      productName: anchor.productName,
      sku: anchor.sku,
    },
    caps: {
      direction: query.direction,
      maxDepth: query.maxDepth,
      maxNodes: query.maxNodes,
      maxFanout: query.maxFanout,
    },
    nodes: nodeList,
    edges: [...edges.values()],
    truncation: {
      complete: truncationReasons.length === 0,
      reasons: truncationReasons,
      depthReached: nodeList.reduce((max, node) => Math.max(max, node.depth), 0),
      nodeCount: nodeList.length,
      edgeCount: edges.size,
      unexploredNodes: nodeList.filter((n) => n.unexplored).length,
      fanoutTruncatedNodes: nodeList.filter((n) => n.fanoutTruncated).map((n) => n.key),
    },
    corrections: { excludedFromWalk: !query.includeReversed },
    warehouseScoped,
  };
}
