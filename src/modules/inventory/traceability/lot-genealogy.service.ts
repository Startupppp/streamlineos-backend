import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import {
  WarehouseScopeService,
  type ResolvedWarehouseScope,
} from "../stock-engine/warehouse-scope.service";
import type { GenealogyQueryInput } from "./dto/genealogy.schemas";
import type {
  GenealogyEdge,
  GenealogyNode,
  GenealogyResult,
  GenealogyTruncationReason,
} from "./genealogy.types";
import { documentFallbackLabel } from "./lib/genealogy-labels";
import { applyGenealogyLabels, renderGenealogy } from "./lib/genealogy-result";
import {
  documentKey,
  expandContainment,
  expandDocuments,
  expandItemsOfKind,
  itemKey,
  loadAnchor,
  type DocumentRef,
  type GenealogyScopeFilters,
  type ItemRef,
  type LedgerRow,
} from "./lib/genealogy-queries";

const toIso = (value: Date | string | null): string | null => {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : String(value);
};

const placeholderLabel = (kind: "lot" | "serial", id: number): string =>
  `${kind === "lot" ? "Lot" : "Serial"} #${String(id)}`;

/**
 * Edges per node the answer will carry.
 *
 * The node cap bounds how much of the graph is walked; this bounds how large
 * the answer can get, because one pair of nodes can be joined by as many edges
 * as there were movements between them and the response has to stay a
 * predictable size. A graph denser than this is past the point where anyone
 * reads it as a graph, and the answer says it was cut rather than pretending.
 */
const EDGES_PER_NODE = 5;

/**
 * D1 — the lot/serial genealogy graph.
 *
 * The graph is bipartite: item nodes (a lot or a serial) and document nodes (a
 * receipt, transfer, sales order, return, adjustment), joined by the movements
 * `inv_stock_transactions` already records plus the one real parent/child FK in
 * the schema, `inv_serial_numbers.lot_id`. Nothing here is inferred.
 *
 * **Why a frontier loop and not one recursive CTE.** A recursive term over this
 * schema has to reach the ledger by lot id, by serial id *or* by document
 * reference depending on what kind of node the working row holds — an `OR`
 * across three different indexes, the exact shape backend §7 says defeats all
 * of them. PostgreSQL also forbids the `LATERAL … LIMIT` and the window
 * functions that would give a per-node breadth cap inside a recursive term, so
 * the only cap a recursive CTE could carry is depth. This loop's round-trip
 * count is itself capped by `maxDepth`, and every statement it issues carries
 * its caps in SQL: `LATERAL … LIMIT maxFanout + 1` per frontier node for
 * breadth, an outer `LIMIT` for the level. Nothing unbounded is materialised.
 *
 * Every cap asks for one row more than it will use. A full page is how the walk
 * learns it was cut off, and a cut-off answer says so in `truncation`.
 */
@Injectable()
export class LotGenealogyService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly warehouseScope: WarehouseScopeService,
  ) {}

  async getGraph(
    orgId: string,
    userId: string,
    query: GenealogyQueryInput,
  ): Promise<GenealogyResult> {
    const scope = await this.warehouseScope.forUser(orgId, userId);
    const filters = this.scopeFilters(orgId, scope);
    const anchor = await loadAnchor(this.db, orgId, query, filters);

    const nodes = new Map<string, GenealogyNode>();
    const edges = new Map<string, GenealogyEdge>();
    const reasons = new Set<GenealogyTruncationReason>();
    if (!scope.unrestricted) reasons.add("WAREHOUSE_SCOPE");

    const anchorKey = itemKey(anchor.kind, anchor.id);
    nodes.set(anchorKey, {
      key: anchorKey,
      kind: anchor.kind,
      label: anchor.label,
      depth: 0,
      lotId: anchor.kind === "lot" ? anchor.id : null,
      serialId: anchor.kind === "serial" ? anchor.id : null,
      referenceType: null,
      referenceId: null,
      fanoutTruncated: false,
      unexplored: false,
    });

    let itemFrontier: ItemRef[] = [{ kind: anchor.kind, id: anchor.id }];
    let documentFrontier: DocumentRef[] = [];

    for (let depth = 1; depth <= query.maxDepth; depth++) {
      if (itemFrontier.length === 0 && documentFrontier.length === 0) break;
      if (nodes.size >= query.maxNodes) {
        reasons.add("MAX_NODES");
        break;
      }

      const level = await this.expandLevel(orgId, itemFrontier, documentFrontier, query, filters);
      const next = this.absorbLevel(level, itemFrontier, depth, query, nodes, edges, reasons);
      itemFrontier = next.items;
      documentFrontier = next.documents;
    }

    if (itemFrontier.length > 0 || documentFrontier.length > 0) {
      reasons.add(nodes.size >= query.maxNodes ? "MAX_NODES" : "MAX_DEPTH");
      for (const ref of itemFrontier) {
        const node = nodes.get(itemKey(ref.kind, ref.id));
        if (node) node.unexplored = true;
      }
      for (const ref of documentFrontier) {
        const node = nodes.get(documentKey(ref));
        if (node) node.unexplored = true;
      }
    }

    await applyGenealogyLabels(this.db, orgId, nodes);
    return renderGenealogy({
      anchor,
      anchorKey,
      query,
      nodes,
      edges,
      reasons,
      warehouseScoped: !scope.unrestricted,
    });
  }

  private async expandLevel(
    orgId: string,
    itemFrontier: readonly ItemRef[],
    documentFrontier: readonly DocumentRef[],
    query: GenealogyQueryInput,
    scope: GenealogyScopeFilters,
  ): Promise<{
    ledger: LedgerRow[];
    containment: Awaited<ReturnType<typeof expandContainment>>;
  }> {
    const lots = itemFrontier.filter((f) => f.kind === "lot");
    const serials = itemFrontier.filter((f) => f.kind === "serial");
    const [lotRows, serialRows, documentRows, containment] = await Promise.all([
      expandItemsOfKind(this.db, orgId, "lot", lots, query, scope),
      expandItemsOfKind(this.db, orgId, "serial", serials, query, scope),
      expandDocuments(this.db, orgId, documentFrontier, query, scope),
      expandContainment(this.db, orgId, itemFrontier, query, scope),
    ]);
    return { ledger: [...lotRows, ...serialRows, ...documentRows], containment };
  }

  private absorbLevel(
    level: { ledger: LedgerRow[]; containment: Awaited<ReturnType<typeof expandContainment>> },
    itemFrontier: readonly ItemRef[],
    depth: number,
    query: GenealogyQueryInput,
    nodes: Map<string, GenealogyNode>,
    edges: Map<string, GenealogyEdge>,
    reasons: Set<GenealogyTruncationReason>,
  ): { items: ItemRef[]; documents: DocumentRef[] } {
    const nextItems = new Map<string, ItemRef>();
    const nextDocuments = new Map<string, DocumentRef>();
    const itemSources = new Set(itemFrontier.map((f) => itemKey(f.kind, f.id)));

    const addNode = (node: Omit<GenealogyNode, "fanoutTruncated" | "unexplored">): boolean => {
      if (nodes.has(node.key)) return false;
      if (nodes.size >= query.maxNodes) return false;
      nodes.set(node.key, { ...node, fanoutTruncated: false, unexplored: false });
      return true;
    };

    const addEdge = (edge: GenealogyEdge): void => {
      if (!nodes.has(edge.from) || !nodes.has(edge.to)) return;
      const key = `${edge.from}|${edge.to}|${edge.kind}|${String(edge.transactionId ?? 0)}`;
      if (edges.has(key)) return;
      if (edges.size >= query.maxNodes * EDGES_PER_NODE) {
        reasons.add("MAX_EDGES");
        return;
      }
      edges.set(key, edge);
    };

    for (const row of level.ledger) {
      const item: ItemRef | null =
        row.serial_id != null
          ? { kind: "serial", id: row.serial_id }
          : row.lot_id != null
            ? { kind: "lot", id: row.lot_id }
            : null;
      if (!item) continue;

      const document: DocumentRef = {
        referenceType: row.reference_type,
        referenceId: row.reference_id,
      };
      const fromItem = itemSources.has(row.source_key);
      const targetKey = fromItem ? documentKey(document) : itemKey(item.kind, item.id);
      if (targetKey === row.source_key) continue;

      const alreadyKnown = nodes.has(targetKey);
      const added = fromItem
        ? addNode({
            key: targetKey,
            kind: "document",
            label: documentFallbackLabel(document.referenceType, document.referenceId),
            depth,
            lotId: null,
            serialId: null,
            referenceType: document.referenceType,
            referenceId: document.referenceId,
          })
        : addNode({
            key: targetKey,
            kind: item.kind,
            label: placeholderLabel(item.kind, item.id),
            depth,
            lotId: item.kind === "lot" ? item.id : null,
            serialId: item.kind === "serial" ? item.id : null,
            referenceType: null,
            referenceId: null,
          });
      if (!added && !alreadyKnown) reasons.add("MAX_NODES");

      // The edge is drawn the way the goods moved: a negative movement took
      // them out of the item and into the document, a positive one brought
      // them the other way.
      const itemNode = fromItem ? row.source_key : targetKey;
      const documentNode = fromItem ? targetKey : row.source_key;
      const outbound = row.quantity_change.trim().startsWith("-");
      addEdge({
        from: outbound ? itemNode : documentNode,
        to: outbound ? documentNode : itemNode,
        kind: "MOVEMENT",
        direction: outbound ? "forward" : "backward",
        transactionId: row.id,
        transactionType: row.transaction_type,
        quantity: row.quantity_change,
        locationId: row.location_id,
        occurredAt: toIso(row.created_at),
        reversed: row.reversed,
        closesCycle: alreadyKnown,
      });

      if (!added) continue;
      if (fromItem) nextDocuments.set(targetKey, document);
      else nextItems.set(targetKey, item);
    }

    for (const link of level.containment.links) {
      const targetKey = itemKey(link.kind, link.id);
      const alreadyKnown = nodes.has(targetKey);
      const added = addNode({
        key: targetKey,
        kind: link.kind,
        label: placeholderLabel(link.kind, link.id),
        depth,
        lotId: link.kind === "lot" ? link.id : null,
        serialId: link.kind === "serial" ? link.id : null,
        referenceType: null,
        referenceId: null,
      });
      if (!added && !alreadyKnown) reasons.add("MAX_NODES");
      const lotNode = link.kind === "serial" ? link.sourceKey : targetKey;
      const serialNode = link.kind === "serial" ? targetKey : link.sourceKey;
      addEdge({
        from: lotNode,
        to: serialNode,
        kind: "CONTAINS",
        direction: link.kind === "serial" ? "forward" : "backward",
        transactionId: null,
        transactionType: null,
        quantity: null,
        locationId: null,
        occurredAt: null,
        reversed: false,
        closesCycle: alreadyKnown,
      });
      if (added) nextItems.set(targetKey, link);
    }

    for (const key of this.overflowingSources(level.ledger, query.maxFanout)) {
      const node = nodes.get(key);
      if (node) node.fanoutTruncated = true;
      reasons.add("MAX_FANOUT");
    }
    for (const key of level.containment.overflowed) {
      const node = nodes.get(key);
      if (node) node.fanoutTruncated = true;
      reasons.add("MAX_FANOUT");
    }

    return { items: [...nextItems.values()], documents: [...nextDocuments.values()] };
  }

  /**
   * A source that came back with more than `maxFanout` rows had more to give.
   * The extra rows are kept as edges where the node budget allows, but the node
   * they came from is flagged so the answer never reads as exhaustive.
   */
  private overflowingSources(rows: readonly LedgerRow[], maxFanout: number): string[] {
    const counts = new Map<string, number>();
    for (const row of rows) counts.set(row.source_key, (counts.get(row.source_key) ?? 0) + 1);
    return [...counts].filter(([, n]) => n > maxFanout).map(([key]) => key);
  }

  /**
   * The caller's warehouse scope, turned into the predicate every statement in
   * this walk carries.
   *
   * Built here rather than in the query file so the service that resolves a
   * scope is visibly the service that applies it: a scope acquired and then
   * dropped on the way to the query is the failure
   * `inventory-scope-cache-keys.spec.ts` guards against, and it cannot see
   * across files.
   *
   * A caller assigned to no warehouse gets `FALSE` from every predicate, so the
   * anchor is not found and the answer is 404 rather than an empty graph — an
   * empty graph would read as "this lot never moved".
   */
  private scopeFilters(orgId: string, scope: ResolvedWarehouseScope): GenealogyScopeFilters {
    if (scope.unrestricted) {
      return {
        ledgerLocation: sql`TRUE`,
        serialLocation: sql`TRUE`,
        lotVisible: sql`TRUE`,
        serialVisible: sql`TRUE`,
      };
    }
    const ledgerLocation = sql`(t.location_id IS NOT NULL AND ${scope.location(sql.raw("t.location_id"))})`;
    const serialLocation = sql`(s.current_location_id IS NOT NULL AND ${scope.location(sql.raw("s.current_location_id"))})`;
    return {
      ledgerLocation,
      serialLocation,
      serialVisible: serialLocation,
      // Attribution follows the rule `listLots` already uses: a lot is the
      // caller's to see when it holds stock in a location they are assigned to.
      lotVisible: sql`EXISTS (
        SELECT 1 FROM inv_stock_levels sl
        WHERE sl.org_id = ${orgId} AND sl.lot_id = l.id
          AND ${scope.location(sql.raw("sl.location_id"))})`,
    };
  }
}
