/**
 * Plan-tree arithmetic, kept separate from the runner so it can be self-tested without a database.
 *
 * "Buffers" below always means shared hit + shared read. Local and temp blocks are reported
 * separately where they appear, because a materialised CTE spilling to temp is invisible in the
 * shared counters and is exactly the failure mode this harness exists to catch.
 */

const SCAN_TYPES = new Set([
  "Seq Scan",
  "Index Scan",
  "Index Only Scan",
  "Bitmap Heap Scan",
  "Tid Scan",
  "Function Scan",
]);

export function nodeBuffers(node) {
  return (node["Shared Hit Blocks"] ?? 0) + (node["Shared Read Blocks"] ?? 0);
}

/** Inclusive buffers minus the children's, so a parent is not credited with its child's work. */
export function exclusiveBuffers(node) {
  const children = node.Plans ?? [];
  return nodeBuffers(node) - children.reduce((sum, c) => sum + nodeBuffers(c), 0);
}

export function flatten(node, out = [], depth = 0) {
  out.push({ node, depth });
  for (const child of node.Plans ?? []) flatten(child, out, depth + 1);
  return out;
}

/** The node that actually costs the query, by buffers it touched itself. */
export function dominantNode(root) {
  let best = null;
  for (const { node } of flatten(root)) {
    const excl = exclusiveBuffers(node);
    if (best === null || excl > best.exclusive) {
      best = {
        exclusive: excl,
        type: node["Node Type"],
        relation: node["Relation Name"] ?? null,
        index: node["Index Name"] ?? null,
        actualRows: node["Actual Rows"] ?? 0,
        removedByFilter:
          (node["Rows Removed by Filter"] ?? 0) + (node["Rows Removed by Index Recheck"] ?? 0),
      };
    }
  }
  return best;
}

/**
 * Rows the storage layer actually had to look at, versus the rows the query returned.
 * EXPLAIN reports per-loop averages, so a nested-loop inner side is multiplied back out —
 * without that a 1-row inner scan run 50,000 times reads as 1 row.
 */
export function rowsRead(root) {
  let total = 0;
  for (const { node } of flatten(root)) {
    if (!SCAN_TYPES.has(node["Node Type"])) continue;
    const loops = node["Actual Loops"] ?? 1;
    const perLoop =
      (node["Actual Rows"] ?? 0) +
      (node["Rows Removed by Filter"] ?? 0) +
      (node["Rows Removed by Index Recheck"] ?? 0);
    total += perLoop * loops;
  }
  return total;
}

export function tempBlocks(root) {
  let read = 0;
  let written = 0;
  for (const { node } of flatten(root)) {
    read += node["Temp Read Blocks"] ?? 0;
    written += node["Temp Written Blocks"] ?? 0;
  }
  return { read, written };
}

export function usedIndexes(root) {
  const names = new Set();
  for (const { node } of flatten(root)) if (node["Index Name"]) names.add(node["Index Name"]);
  return [...names];
}

export function seqScannedRelations(root) {
  const rels = [];
  for (const { node } of flatten(root))
    if (node["Node Type"] === "Seq Scan" && node["Relation Name"]) rels.push(node["Relation Name"]);
  return rels;
}

export function summarize(root) {
  return {
    buffers: nodeBuffers(root),
    sharedHit: root["Shared Hit Blocks"] ?? 0,
    sharedRead: root["Shared Read Blocks"] ?? 0,
    rowsReturned: root["Actual Rows"] ?? 0,
    rowsRead: rowsRead(root),
    temp: tempBlocks(root),
    dominant: dominantNode(root),
    indexes: usedIndexes(root),
    seqScans: seqScannedRelations(root),
    planningMs: null,
    executionMs: null,
  };
}

export function selfTest() {
  const child = {
    "Node Type": "Seq Scan",
    "Relation Name": "calendar_events",
    "Shared Hit Blocks": 500,
    "Shared Read Blocks": 16,
    "Actual Rows": 200,
    "Rows Removed by Filter": 47500,
    "Actual Loops": 1,
  };
  const root = {
    "Node Type": "Limit",
    "Shared Hit Blocks": 505,
    "Shared Read Blocks": 16,
    "Actual Rows": 200,
    "Temp Written Blocks": 3,
    Plans: [child],
  };
  const s = summarize(root);
  const cases = [
    ["total buffers are hit + read", s.buffers, 521],
    ["rows read counts filtered rows", s.rowsRead, 47700],
    ["rows returned is the root's", s.rowsReturned, 200],
    ["dominant node is the scan, not the Limit", s.dominant.type, "Seq Scan"],
    ["dominant exclusive buffers exclude the child", s.dominant.exclusive, 516],
    ["seq scans are named", s.seqScans.join(","), "calendar_events"],
    ["temp blocks bubble up", s.temp.written, 3],
    ["a Limit above a scan is not itself dominant", exclusiveBuffers(root), 5],
    [
      "a nested-loop inner side is multiplied back out by its loop count",
      rowsRead({
        "Node Type": "Nested Loop",
        "Actual Rows": 5,
        Plans: [
          { "Node Type": "Seq Scan", "Relation Name": "a", "Actual Rows": 50000, "Actual Loops": 1 },
          { "Node Type": "Index Scan", "Relation Name": "b", "Actual Rows": 1, "Actual Loops": 50000 },
        ],
      }),
      100000,
    ],
  ];
  let failed = false;
  for (const [label, actual, wanted] of cases) {
    if (actual === wanted) console.log(`  [pass] ${label}`);
    else {
      console.error(`  [FAIL] ${label}: expected ${JSON.stringify(wanted)}, got ${JSON.stringify(actual)}`);
      failed = true;
    }
  }
  return !failed;
}
