/**
 * Shared connection guards and plan helpers for the KB retrieval probes.
 *
 * These live here rather than in either measurement script because both the
 * latency harness and the recall harness must obey the same three rules, and a
 * second private copy of them is exactly how one of the two quietly stops
 * obeying one:
 *
 * - **A scratch database only.** Both URLs must match `/\/scratch_/`. The
 *   seeder bulk-loads 49,000 rows and rebuilds an index; pointed at a real
 *   database that is a destructive operation wearing a benchmark's name.
 * - **Never as the owner.** `neondb_owner` has BYPASSRLS, so its plans omit the
 *   `org_id = app.current_org_id()` qual that is the subject of the
 *   measurement. `assertAppRoleIsNotPrivileged` refuses to run as such a role
 *   and `assertRlsBites` proves the GUC really gates the table, so a silent
 *   privilege change cannot pass unnoticed.
 * - **Every measured statement rolls back.** `inRolledBackTx` is the only way
 *   these scripts touch the database on the application connection, so a probe
 *   can never leave state behind for the next one to measure.
 */
import postgres from "postgres";

export function openConnections() {
  const ownerUrl = process.env.PERF_DATABASE_URL;
  const appUrl = process.env.PERF_APP_DATABASE_URL;
  if (!ownerUrl || !appUrl) {
    console.error("PERF_DATABASE_URL and PERF_APP_DATABASE_URL are both required.");
    process.exit(2);
  }
  for (const [name, url] of [
    ["PERF_DATABASE_URL", ownerUrl],
    ["PERF_APP_DATABASE_URL", appUrl],
  ])
    if (!/\/scratch_/.test(url)) {
      console.error(`Refusing to run: ${name} must name a scratch_* database.`);
      process.exit(2);
    }
  return {
    owner: postgres(ownerUrl, { max: 1, onnotice: () => {} }),
    app: postgres(appUrl, { max: 1, onnotice: () => {} }),
  };
}

export async function assertAppRoleIsNotPrivileged(app) {
  const [role] = await app`
    SELECT current_user AS name, rolbypassrls, rolsuper
    FROM pg_roles WHERE rolname = current_user`;
  if (role.rolbypassrls || role.rolsuper)
    throw new Error(
      `Refusing to measure as ${role.name}: it bypasses RLS, so the tenant qual would not be planned.`,
    );
  return role.name;
}

/** Proves the GUC really gates the table, so a silent BYPASSRLS cannot pass unnoticed. */
export async function assertRlsBites(app) {
  let raised = null;
  try {
    await app.begin(async (tx) => {
      await tx.unsafe(`SELECT count(*) FROM public.kb_article_chunks`);
      throw new Error("ROLLBACK");
    });
  } catch (error) {
    raised = error;
  }
  const message = raised instanceof Error ? raised.message : String(raised);
  if (!/no tenant context|42501/.test(message))
    throw new Error(`Expected 42501 with no tenant GUC, got: ${message}`);
}

/**
 * pgvector registers `hnsw.ef_search` when its library loads into the backend.
 * Before that a `SET` lands on an unrecognised-prefix placeholder and `SHOW`
 * raises — so any script that means to sweep the knob loads the library first
 * and then reads the value back rather than trusting the `SET`.
 */
export async function loadVectorLibrary(app) {
  await app.unsafe(`SELECT '[1,0]'::vector <=> '[0,1]'::vector`);
}

export async function inRolledBackTx(app, setup, run) {
  let result;
  await app
    .begin(async (tx) => {
      for (const statement of setup) await tx.unsafe(statement);
      result = await run(tx);
      throw new Error("__rollback__");
    })
    .catch((error) => {
      if (!(error instanceof Error) || error.message !== "__rollback__") throw error;
    });
  return result;
}

export function percentile(sortedAscending, fraction) {
  if (sortedAscending.length === 0) return 0;
  const index = Math.min(
    sortedAscending.length - 1,
    Math.max(0, Math.ceil(fraction * sortedAscending.length) - 1),
  );
  return sortedAscending[index];
}

export function sumBuffers(node, acc = { hit: 0, read: 0 }) {
  acc.hit += node["Shared Hit Blocks"] ?? 0;
  acc.read += node["Shared Read Blocks"] ?? 0;
  for (const child of node.Plans ?? []) sumBuffers(child, acc);
  return acc;
}

export function describePlan(node) {
  const names = [];
  const walk = (n) => {
    names.push(n["Node Type"] === "Index Scan" ? `Index Scan(${n["Index Name"]})` : n["Node Type"]);
    for (const c of n.Plans ?? []) walk(c);
  };
  walk(node);
  return names.join(" > ");
}
