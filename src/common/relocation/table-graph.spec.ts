import {
  deletionOrder,
  tableKey,
  topologicalOrder,
  type ForeignKeyEdge,
  type GraphTable,
} from "./table-graph";

const t = (table: string, schema = "public"): GraphTable => ({ schema, table });

const edge = (
  child: string,
  parent: string,
  deferrable = false,
): ForeignKeyEdge => ({
  childSchema: "public",
  childTable: child,
  parentSchema: "public",
  parentTable: parent,
  deferrable,
});

const names = (tables: readonly GraphTable[]): string[] => tables.map((x) => x.table);

const positionOf = (tables: readonly GraphTable[], name: string): number =>
  names(tables).indexOf(name);

describe("topologicalOrder", () => {
  it("puts a parent before the child that references it", () => {
    const { ordered } = topologicalOrder([t("child"), t("parent")], [edge("child", "parent")]);
    expect(positionOf(ordered, "parent")).toBeLessThan(positionOf(ordered, "child"));
  });

  it("orders a three-level chain root first", () => {
    const { ordered } = topologicalOrder(
      [t("leaf"), t("middle"), t("root")],
      [edge("leaf", "middle"), edge("middle", "root")],
    );
    expect(names(ordered)).toEqual(["root", "middle", "leaf"]);
  });

  it("emits every table exactly once", () => {
    const tables = [t("a"), t("b"), t("c"), t("d")];
    const { ordered } = topologicalOrder(tables, [edge("b", "a"), edge("c", "b"), edge("d", "a")]);
    expect(ordered).toHaveLength(4);
    expect(new Set(names(ordered)).size).toBe(4);
  });

  it("reports a two-table cycle as cyclic", () => {
    const { cyclic } = topologicalOrder(
      [t("loop_a"), t("loop_b")],
      [edge("loop_a", "loop_b"), edge("loop_b", "loop_a")],
    );
    expect(names(cyclic).sort()).toEqual(["loop_a", "loop_b"]);
  });

  it("still emits the members of a cycle in the load order", () => {
    const { ordered, cyclic } = topologicalOrder(
      [t("loop_a"), t("loop_b")],
      [edge("loop_a", "loop_b"), edge("loop_b", "loop_a")],
    );
    expect(ordered).toHaveLength(2);
    expect(cyclic).toHaveLength(2);
  });

  // The defect this replaced: the previous algorithm parked a table whenever any parent was
  // still unresolved, so every table downstream of one small cycle was reported as cyclic too.
  // Against the live catalogue that turned a handful of genuinely cyclic tables into 201, and
  // each one would have had its foreign keys dropped and rebuilt during a real move.
  it("does not report a table as cyclic merely because it depends on a cycle", () => {
    const { ordered, cyclic } = topologicalOrder(
      [t("loop_a"), t("loop_b"), t("downstream"), t("further")],
      [
        edge("loop_a", "loop_b"),
        edge("loop_b", "loop_a"),
        edge("downstream", "loop_a"),
        edge("further", "downstream"),
      ],
    );
    expect(names(cyclic).sort()).toEqual(["loop_a", "loop_b"]);
    expect(ordered).toHaveLength(4);
    expect(positionOf(ordered, "downstream")).toBeGreaterThan(positionOf(ordered, "loop_a"));
    expect(positionOf(ordered, "further")).toBeGreaterThan(positionOf(ordered, "downstream"));
  });

  it("reports two independent cycles separately and keeps both", () => {
    const { cyclic } = topologicalOrder(
      [t("a1"), t("a2"), t("b1"), t("b2")],
      [edge("a1", "a2"), edge("a2", "a1"), edge("b1", "b2"), edge("b2", "b1")],
    );
    expect(names(cyclic).sort()).toEqual(["a1", "a2", "b1", "b2"]);
  });

  it("treats a self-reference as orderable, not as a cycle between tables", () => {
    const { ordered, cyclic } = topologicalOrder([t("tree")], [edge("tree", "tree")]);
    expect(cyclic).toHaveLength(0);
    expect(names(ordered)).toEqual(["tree"]);
  });

  it("ignores a deferrable constraint, which does not constrain load order", () => {
    const { ordered, cyclic } = topologicalOrder(
      [t("loop_a"), t("loop_b")],
      [edge("loop_a", "loop_b"), edge("loop_b", "loop_a", true)],
    );
    expect(cyclic).toHaveLength(0);
    expect(positionOf(ordered, "loop_b")).toBeLessThan(positionOf(ordered, "loop_a"));
  });

  it("ignores an edge to a table outside the plan", () => {
    const { ordered, cyclic } = topologicalOrder([t("child")], [edge("child", "absent_parent")]);
    expect(cyclic).toHaveLength(0);
    expect(names(ordered)).toEqual(["child"]);
  });

  it("separates tables with the same name in different schemas", () => {
    const { ordered } = topologicalOrder(
      [t("tickets", "build"), t("tickets", "public")],
      [],
    );
    expect(ordered).toHaveLength(2);
    expect(tableKey("build", "tickets")).not.toBe(tableKey("public", "tickets"));
  });

  it("handles an empty plan", () => {
    const { ordered, cyclic } = topologicalOrder([], []);
    expect(ordered).toHaveLength(0);
    expect(cyclic).toHaveLength(0);
  });

  it("orders a deep chain without recursing into a stack overflow", () => {
    const depth = 2000;
    const tables = Array.from({ length: depth }, (_, i) => t(`t${i}`));
    const edges = Array.from({ length: depth - 1 }, (_, i) => edge(`t${i + 1}`, `t${i}`));
    const { ordered, cyclic } = topologicalOrder(tables, edges);
    expect(ordered).toHaveLength(depth);
    expect(cyclic).toHaveLength(0);
    expect(positionOf(ordered, "t0")).toBeLessThan(positionOf(ordered, `t${depth - 1}`));
  });
});

describe("deletionOrder", () => {
  it("is the reverse of the load order, so a child goes before its parent", () => {
    const { ordered } = topologicalOrder([t("child"), t("parent")], [edge("child", "parent")]);
    const deletion = deletionOrder(ordered);
    expect(positionOf(deletion, "child")).toBeLessThan(positionOf(deletion, "parent"));
  });

  it("does not mutate the load order it was given", () => {
    const { ordered } = topologicalOrder([t("child"), t("parent")], [edge("child", "parent")]);
    const before = names(ordered);
    deletionOrder(ordered);
    expect(names(ordered)).toEqual(before);
  });
});
