import type { GenealogyNode, GenealogyResult } from "../genealogy.types";

const HEADER = [
  "anchor",
  "from_key",
  "from_label",
  "from_kind",
  "from_depth",
  "to_key",
  "to_label",
  "to_kind",
  "to_depth",
  "edge_kind",
  "direction",
  "transaction_id",
  "transaction_type",
  "quantity",
  "location_id",
  "occurred_at",
  "reversed",
  "closes_cycle",
  "graph_complete",
  "graph_truncation_reasons",
] as const;

function escape(value: string | number | boolean | null): string {
  if (value === null) return "";
  const text = String(value);
  return /["\n,]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * D1. One row per edge, and every row restates whether the graph it came from
 * was complete.
 *
 * A truncated export that looks complete is the failure this whole unit is
 * about: a spreadsheet outlives the response that produced it, so the caveat
 * has to travel on the data, not only in a header a consumer may drop.
 */
export function genealogyToCsv(graph: GenealogyResult): string {
  const nodes = new Map<string, GenealogyNode>(graph.nodes.map((n) => [n.key, n]));
  const complete = graph.truncation.complete ? "true" : "false";
  const reasons = graph.truncation.reasons.join(" ");

  const lines = [HEADER.join(",")];
  for (const edge of graph.edges) {
    const from = nodes.get(edge.from);
    const to = nodes.get(edge.to);
    lines.push(
      [
        graph.anchor.label,
        edge.from,
        from?.label ?? "",
        from?.kind ?? "",
        from?.depth ?? "",
        edge.to,
        to?.label ?? "",
        to?.kind ?? "",
        to?.depth ?? "",
        edge.kind,
        edge.direction,
        edge.transactionId,
        edge.transactionType,
        edge.quantity,
        edge.locationId,
        edge.occurredAt,
        edge.reversed,
        edge.closesCycle,
        complete,
        reasons,
      ]
        .map((v) => escape(v as string | number | boolean | null))
        .join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}
