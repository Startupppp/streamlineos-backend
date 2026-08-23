import { nextNodeId, parseWorkflowGraph } from "../workflow-graph";

function node(id: string, nodeType: string, configuration?: unknown) {
  return {
    id,
    type: "workflowNode",
    position: { x: 0, y: 0 },
    data: { label: id, nodeType, configuration: configuration ?? {} },
  };
}

describe("parseWorkflowGraph", () => {
  it("accepts a definition carrying React Flow's own fields", () => {
    const parsed = parseWorkflowGraph({
      nodes: [node("t", "trigger"), node("e", "end")],
      edges: [{ id: "t-e", source: "t", target: "e", style: { stroke: "red" } }],
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.graph.startNodeId).toBe("t");
    expect(parsed.graph.nodesById.size).toBe(2);
  });

  it("starts at the trigger node even when it is not listed first", () => {
    const parsed = parseWorkflowGraph({
      nodes: [node("e", "end"), node("t", "trigger")],
      edges: [{ source: "t", target: "e" }],
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.graph.startNodeId).toBe("t");
  });

  it("falls back to the only node with no incoming edge", () => {
    const parsed = parseWorkflowGraph({
      nodes: [node("a", "condition"), node("b", "end")],
      edges: [{ source: "a", target: "b" }],
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.graph.startNodeId).toBe("a");
  });

  it("refuses two trigger nodes rather than picking one", () => {
    const parsed = parseWorkflowGraph({
      nodes: [node("t1", "trigger"), node("t2", "trigger")],
      edges: [],
    });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("2 trigger nodes");
  });

  it("refuses a graph where every node has an incoming edge", () => {
    const parsed = parseWorkflowGraph({
      nodes: [node("a", "condition"), node("b", "end")],
      edges: [
        { source: "a", target: "b" },
        { source: "b", target: "a" },
      ],
    });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("no start node");
  });

  it("refuses an edge pointing at a node that does not exist", () => {
    const parsed = parseWorkflowGraph({
      nodes: [node("t", "trigger")],
      edges: [{ source: "t", target: "ghost" }],
    });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("ghost");
  });

  it("refuses duplicate node ids", () => {
    const parsed = parseWorkflowGraph({
      nodes: [node("t", "trigger"), node("t", "end")],
      edges: [],
    });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("Duplicate node id");
  });

  it("refuses an unknown node type instead of silently skipping it", () => {
    const parsed = parseWorkflowGraph({
      nodes: [node("t", "teleport")],
      edges: [],
    });

    expect(parsed.ok).toBe(false);
  });
});

describe("nextNodeId", () => {
  const parsed = parseWorkflowGraph({
    nodes: [node("c", "condition"), node("yes", "end"), node("no", "end")],
    edges: [
      { source: "c", target: "yes", sourceHandle: "true" },
      { source: "c", target: "no", sourceHandle: "false" },
    ],
  });

  it("follows the handle matching the branch", () => {
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(nextNodeId(parsed.graph, "c", "true")).toBe("yes");
    expect(nextNodeId(parsed.graph, "c", "false")).toBe("no");
  });

  it("returns null at a node with no outgoing edge", () => {
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(nextNodeId(parsed.graph, "yes")).toBeNull();
  });

  it("follows an unlabelled edge on any branch, which is what the builder emits", () => {
    const plain = parseWorkflowGraph({
      nodes: [node("c", "condition"), node("e", "end")],
      edges: [{ source: "c", target: "e" }],
    });

    expect(plain.ok).toBe(true);
    if (!plain.ok) return;
    expect(nextNodeId(plain.graph, "c", "false")).toBe("e");
  });
});
