import postgres from "postgres";
const ORG = "aa5627a2-a7de-4dca-97d2-135f3a5f801b";
const sql = postgres(process.env.APP_DATABASE_URL, { prepare: false, max: 1, connect_timeout: 20 });

const PROJECT = process.argv[2] ? Number(process.argv[2]) : null;

const sorts = {
  rank:     `t.rank ASC, t.created_at DESC, t.id ASC`,
  created:  `t.created_at DESC, t.created_at DESC, t.id ASC`,
  updated:  `t.updated_at DESC, t.created_at DESC, t.id ASC`,
  priority: `t.priority ASC, t.created_at DESC, t.id ASC`,
  dueDate:  `t.due_date ASC, t.created_at DESC, t.id ASC`,
};

function summarise(plan) {
  const root = plan[0]["Plan"];
  let blocks = 0, nodes = [];
  const walk = (n) => {
    blocks += (n["Shared Hit Blocks"] ?? 0) + (n["Shared Read Blocks"] ?? 0);
    nodes.push(n["Node Type"] + (n["Relation Name"] ? ` on ${n["Relation Name"]}` : "") + (n["Index Name"] ? ` [${n["Index Name"]}]` : ""));
    for (const c of n["Plans"] ?? []) walk(c);
  };
  walk(root);
  return { blocks, ms: plan[0]["Execution Time"], nodes };
}

for (const [name, order] of Object.entries(sorts)) {
  const projClause = PROJECT ? `AND t.project_id = ${PROJECT}` : "";
  const q = `SELECT t.id, count(*) OVER () AS total FROM build.tickets t
             WHERE t.org_id = '${ORG}' ${projClause} AND t.deleted_at IS NULL
             ORDER BY ${order} LIMIT 50 OFFSET 0`;
  try {
    const out = await sql.begin(async (tx) => {
      await tx.unsafe(`SELECT set_config('app.organization_id', '${ORG}', true), set_config('app.audience', 'member', true)`);
      return tx.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${q}`);
    });
    const plan = out[0]["QUERY PLAN"];
    const s = summarise(plan);
    const scan = s.nodes.find(n => n.includes("Scan")) ?? "?";
    console.log(`${name.padEnd(9)} blocks=${String(s.blocks).padStart(7)}  ${s.ms.toFixed(1)}ms  ${scan}`);
  } catch (e) {
    console.log(`${name.padEnd(9)} ERROR ${e.code} ${e.message.slice(0,90)}`);
  }
}
await sql.end({ timeout: 5 });
