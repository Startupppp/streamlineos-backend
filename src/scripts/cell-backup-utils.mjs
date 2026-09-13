const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export function requireSafeTarget(topo) {
  for (const url of [topo.cell.ownerDirect, topo.cell.app].filter(Boolean)) {
    const host = new URL(url).hostname;
    if (!LOCAL_HOSTS.has(host))
      throw new Error(
        `Unsafe target refused: "${host}" is not a local host. ` +
          `Recovery drills require a local scratch database (localhost / 127.0.0.1).`,
      );
  }
}

export function topologicalOrder(tables, edges) {
  const key = (schema, table) => `${schema}.${table}`;
  const present = new Set(tables.map((t) => key(t.schema, t.table)));
  const parents = new Map(tables.map((t) => [key(t.schema, t.table), new Set()]));

  for (const e of edges) {
    const child = key(e.child_schema, e.child);
    const parent = key(e.parent_schema, e.parent);
    if (child === parent) continue;
    if (e.deferrable) continue;
    if (!present.has(child) || !present.has(parent)) continue;
    parents.get(child).add(parent);
  }

  const ordered = [];
  const emitted = new Set();
  let progress = true;

  while (progress) {
    progress = false;
    for (const t of tables) {
      const id = key(t.schema, t.table);
      if (emitted.has(id)) continue;
      const blockers = [...parents.get(id)].filter((p) => !emitted.has(p));
      if (blockers.length > 0) continue;
      emitted.add(id);
      ordered.push(t);
      progress = true;
    }
  }

  const cyclic = tables.filter((t) => !emitted.has(key(t.schema, t.table)));
  return { ordered, cyclic };
}
