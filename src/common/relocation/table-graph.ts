export interface GraphTable {
  readonly schema: string;
  readonly table: string;
}

export interface ForeignKeyEdge {
  readonly childSchema: string;
  readonly childTable: string;
  readonly parentSchema: string;
  readonly parentTable: string;
  readonly deferrable: boolean;
}

export interface TopologicalResult<T extends GraphTable> {
  readonly ordered: readonly T[];
  readonly cyclic: readonly T[];
}

export function tableKey(schema: string, table: string): string {
  return `${schema}.${table}`;
}

function dependencyGraph<T extends GraphTable>(
  tables: readonly T[],
  edges: readonly ForeignKeyEdge[],
): Map<string, Set<string>> {
  const present = new Set(tables.map((t) => tableKey(t.schema, t.table)));
  const parents = new Map<string, Set<string>>(
    tables.map((t) => [tableKey(t.schema, t.table), new Set<string>()]),
  );
  for (const edge of edges) {
    const child = tableKey(edge.childSchema, edge.childTable);
    const parent = tableKey(edge.parentSchema, edge.parentTable);
    if (child === parent) continue;
    if (edge.deferrable) continue;
    if (!present.has(child) || !present.has(parent)) continue;
    parents.get(child)?.add(parent);
  }
  return parents;
}

function stronglyConnectedComponents(
  nodes: readonly string[],
  edgesFrom: ReadonlyMap<string, Set<string>>,
): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;

  for (const root of nodes) {
    if (index.has(root)) continue;
    const work: { node: string; iterator: Iterator<string> }[] = [
      { node: root, iterator: (edgesFrom.get(root) ?? new Set<string>())[Symbol.iterator]() },
    ];
    index.set(root, counter);
    low.set(root, counter);
    counter += 1;
    stack.push(root);
    onStack.add(root);

    while (work.length > 0) {
      const frame = work[work.length - 1];
      if (frame === undefined) break;
      const step = frame.iterator.next();

      if (step.done !== true) {
        const next = step.value;
        if (!index.has(next)) {
          index.set(next, counter);
          low.set(next, counter);
          counter += 1;
          stack.push(next);
          onStack.add(next);
          work.push({
            node: next,
            iterator: (edgesFrom.get(next) ?? new Set<string>())[Symbol.iterator](),
          });
          continue;
        }
        if (onStack.has(next))
          low.set(frame.node, Math.min(low.get(frame.node) ?? 0, index.get(next) ?? 0));
        continue;
      }

      work.pop();
      const parentFrame = work[work.length - 1];
      if (parentFrame !== undefined)
        low.set(
          parentFrame.node,
          Math.min(low.get(parentFrame.node) ?? 0, low.get(frame.node) ?? 0),
        );

      if (low.get(frame.node) === index.get(frame.node)) {
        const component: string[] = [];
        for (;;) {
          const popped = stack.pop();
          if (popped === undefined) break;
          onStack.delete(popped);
          component.push(popped);
          if (popped === frame.node) break;
        }
        components.push(component);
      }
    }
  }

  return components;
}

export function topologicalOrder<T extends GraphTable>(
  tables: readonly T[],
  edges: readonly ForeignKeyEdge[],
): TopologicalResult<T> {
  const parents = dependencyGraph(tables, edges);
  const byKey = new Map(tables.map((t) => [tableKey(t.schema, t.table), t]));
  const nodes = [...byKey.keys()];
  const components = stronglyConnectedComponents(nodes, parents);

  const ordered: T[] = [];
  const cyclic: T[] = [];
  for (const component of components) {
    const members = component
      .map((key) => byKey.get(key))
      .filter((t): t is T => t !== undefined);
    for (const member of members) {
      ordered.push(member);
      if (component.length > 1) cyclic.push(member);
    }
  }

  return { ordered, cyclic };
}

export function deletionOrder<T extends GraphTable>(loadOrder: readonly T[]): readonly T[] {
  return [...loadOrder].reverse();
}
