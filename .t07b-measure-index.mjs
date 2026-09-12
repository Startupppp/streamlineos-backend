import postgres from "postgres";
const OWNER = "postgres://neondb_owner@127.0.0.1:5432/scratch_t07b";
const APP   = "postgres://streamline_app@127.0.0.1:5432/scratch_t07b";
const TENANTS = [
  ["89.93%", "aaaaaaaa-1111-0000-0000-000000000001", 3],
  ["9.00%",  "aaaaaaaa-1111-0000-0000-000000000003", 503],
  ["0.90%",  "aaaaaaaa-1111-0000-0000-000000000002", 562],
  ["0.18%",  "aaaaaaaa-1111-0000-0000-000000000004", 571],
];
const CANDIDATES = {
  A: `CREATE INDEX idx_cand ON build.tickets (org_id, assignee_membership_id, status, updated_at DESC)`,
  B: `CREATE INDEX idx_cand ON build.tickets (org_id, assignee_membership_id, updated_at DESC) WHERE deleted_at IS NULL`,
  C: `CREATE INDEX idx_cand ON build.tickets (org_id, assignee_membership_id, updated_at DESC, status) WHERE deleted_at IS NULL`,
};
let CANDIDATE = CANDIDATES.A;
const SQL = (statuses) => `
  SELECT t.id, t.title, t.status, t.priority, t.updated_at,
         p.id AS project_id, p.name AS project_name
  FROM build.tickets t
  LEFT JOIN build.projects p ON p.id = t.project_id
  WHERE t.org_id = $1 AND t.assignee_membership_id = $2 AND t.deleted_at IS NULL
    AND t.status IN (${statuses.map((s) => `'${s}'`).join(", ")})
  ORDER BY t.updated_at DESC
  LIMIT 10`;

function walk(node, acc) {
  acc.buffers += (node["Shared Hit Blocks"] ?? 0) + (node["Shared Read Blocks"] ?? 0);
  acc.rows += node["Actual Rows"] ?? 0;
  if (node["Node Type"] === "Seq Scan") acc.seq.push(node["Relation Name"]);
  if (node["Index Name"]) acc.idx.add(node["Index Name"]);
  for (const c of node.Plans ?? []) walk(c, acc);
  return acc;
}

async function probe(sql, orgId, membershipId, statuses) {
  const rows = await sql.unsafe(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${SQL(statuses)}`,
    [orgId, membershipId],
  );
  const plan = rows[0]["QUERY PLAN"][0].Plan;
  return walk(plan, { buffers: 0, rows: 0, seq: [], idx: new Set() });
}

async function measure(withIndex, statuses, label) {
  const out = [];
  const owner = postgres(OWNER, { max: 1, onnotice: () => {} });
  if (withIndex) {
    await owner.unsafe(CANDIDATE);
    await owner.unsafe("VACUUM ANALYZE build.tickets");
  }
  try {
    for (const [share, orgId, membershipId] of TENANTS) {
      const app = postgres(APP, { max: 1, onnotice: () => {}, prepare: false });
      try {
        await app.unsafe(`SET app.organization_id = '${orgId}'`);
        await probe(app, orgId, membershipId, statuses); // warm
        const r = await probe(app, orgId, membershipId, statuses);
        out.push({ share, buffers: r.buffers, rows: r.rows, seq: r.seq.join(",") || "-",
                   idx: [...r.idx].join(",") || "-" });
      } finally { await app.end(); }
    }
  } finally {
    if (withIndex) await owner.unsafe("DROP INDEX build.idx_cand");
    await owner.end();
  }
  console.log(`\n=== ${label} · ${withIndex ? "WITH candidate index" : "WITHOUT (head)"} ===`);
  console.log("tenant   buffers   scanRows  seqScan  index");
  for (const r of out)
    console.log(`${r.share.padEnd(8)} ${String(r.buffers).padStart(7)}  ${String(r.rows).padStart(8)}  ${r.seq.padEnd(8)} ${r.idx}`);
  return out;
}

const TITLE = ["TODO", "IN_PROGRESS", "IN_REVIEW"];
const base = await measure(false, TITLE, "baseline (head, no candidate) UPPER");
const res = {};
for (const k of ["B"]) {
  CANDIDATE = CANDIDATES[k];
  res[k] = await measure(true, TITLE, `candidate ${k}`);
}
console.log("\n=== BUFFERS: baseline -> A -> B -> C (rows actually match) ===");
for (let i = 0; i < base.length; i++)
  console.log(`${base[i].share.padEnd(8)} ${String(base[i].buffers).padStart(6)} -> ${String(res.B[i].buffers).padStart(6)}   chosen=${res.B[i].idx}`);
