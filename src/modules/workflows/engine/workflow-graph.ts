import { z } from "zod";

export const WORKFLOW_NODE_TYPES = [
  "trigger",
  "condition",
  "approval",
  "action",
  "delay",
  "loop",
  "ai_action",
  "integration",
  "script",
  "end",
] as const;

export type WorkflowNodeType = (typeof WORKFLOW_NODE_TYPES)[number];

/**
 * Deliberately not `.strict()`: the builder stores React Flow's own fields
 * (`type`, `position`, `measured`, `data.description`) alongside ours, so
 * rejecting unknown keys would reject every real definition. This parses
 * persisted data, not a request body.
 */
const workflowNodeSchema = z.object({
  id: z.string().min(1),
  data: z.object({
    nodeType: z.enum(WORKFLOW_NODE_TYPES),
    label: z.string().optional(),
    configuration: z.record(z.string(), z.unknown()).optional(),
  }),
});

const workflowEdgeSchema = z.object({
  source: z.string().min(1),
  target: z.string().min(1),
  sourceHandle: z.string().nullish(),
});

export const workflowDefinitionSchema = z.object({
  nodes: z.array(workflowNodeSchema).min(1),
  edges: z.array(workflowEdgeSchema).optional(),
});

export type WorkflowGraphNode = z.infer<typeof workflowNodeSchema>;
export type WorkflowGraphEdge = z.infer<typeof workflowEdgeSchema>;

export interface WorkflowGraph {
  nodesById: ReadonlyMap<string, WorkflowGraphNode>;
  edgesBySource: ReadonlyMap<string, WorkflowGraphEdge[]>;
  startNodeId: string;
}

export type WorkflowGraphParse =
  | { ok: true; graph: WorkflowGraph }
  | { ok: false; error: string };

function resolveStartNodeId(
  nodes: WorkflowGraphNode[],
  edges: WorkflowGraphEdge[],
): { ok: true; id: string } | { ok: false; error: string } {
  const triggers = nodes.filter((node) => node.data.nodeType === "trigger");
  if (triggers.length === 1) {
    const trigger = triggers[0];
    if (trigger) return { ok: true, id: trigger.id };
  }
  if (triggers.length > 1)
    return {
      ok: false,
      error: `Definition has ${triggers.length} trigger nodes; exactly one is required`,
    };

  const targeted = new Set(edges.map((edge) => edge.target));
  const roots = nodes.filter((node) => !targeted.has(node.id));
  const root = roots[0];
  if (roots.length === 1 && root) return { ok: true, id: root.id };

  return {
    ok: false,
    error:
      roots.length === 0
        ? "Definition has no start node; every node has an incoming edge"
        : `Definition has ${roots.length} possible start nodes and no trigger node`,
  };
}

export function parseWorkflowGraph(definition: unknown): WorkflowGraphParse {
  const parsed = workflowDefinitionSchema.safeParse(definition);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      error: issue
        ? `Invalid workflow definition at ${issue.path.join(".") || "root"}: ${issue.message}`
        : "Invalid workflow definition",
    };
  }

  const nodes = parsed.data.nodes;
  const edges = parsed.data.edges ?? [];

  const nodesById = new Map<string, WorkflowGraphNode>();
  for (const node of nodes) {
    if (nodesById.has(node.id))
      return { ok: false, error: `Duplicate node id "${node.id}"` };
    nodesById.set(node.id, node);
  }

  for (const edge of edges) {
    if (!nodesById.has(edge.source))
      return { ok: false, error: `Edge references unknown source "${edge.source}"` };
    if (!nodesById.has(edge.target))
      return { ok: false, error: `Edge references unknown target "${edge.target}"` };
  }

  const start = resolveStartNodeId(nodes, edges);
  if (!start.ok) return { ok: false, error: start.error };

  const edgesBySource = new Map<string, WorkflowGraphEdge[]>();
  for (const edge of edges) {
    const bucket = edgesBySource.get(edge.source);
    if (bucket) bucket.push(edge);
    else edgesBySource.set(edge.source, [edge]);
  }

  return {
    ok: true,
    graph: { nodesById, edgesBySource, startNodeId: start.id },
  };
}

/**
 * `branch` matches a condition node's `sourceHandle` ("true" / "false"). An edge
 * with no handle is unconditional, so it is followed on every branch — that is
 * what the current builder emits, which draws no labelled handles.
 */
export function nextNodeId(
  graph: WorkflowGraph,
  nodeId: string,
  branch?: string,
): string | null {
  const outgoing = graph.edgesBySource.get(nodeId) ?? [];
  if (outgoing.length === 0) return null;

  if (branch !== undefined) {
    const matched = outgoing.find((edge) => edge.sourceHandle === branch);
    if (matched) return matched.target;
    const unconditional = outgoing.find(
      (edge) => edge.sourceHandle === null || edge.sourceHandle === undefined,
    );
    return unconditional?.target ?? null;
  }

  return outgoing[0]?.target ?? null;
}
