import { resolve } from "node:path";
import * as dotenv from "dotenv";
import postgres from "postgres";
import type { Sql } from "postgres";
import {
  RELOCATION_STATES,
  assertTransitionAllowed,
  canRollback,
  isTerminal,
  type RelocationState,
} from "../common/relocation/relocation-state";
import {
  buildRelocationPlan,
  planCoverage,
  qualifiedName,
  type RelocationPlan,
  type TablePlanEntry,
} from "../common/relocation/relocation-plan";
import {
  deletionOrder,
  topologicalOrder,
} from "../common/relocation/table-graph";
import {
  readCycleBreakers,
  readForeignKeyEdges,
  readPrimaryKeyColumns,
  readTenantTables,
} from "./relocation/catalog-tables";
import {
  deleteSlice,
  qualify,
  readDigest,
  readSlice,
  writeSlice,
} from "./relocation/copy-org";

dotenv.config({ path: resolve(process.cwd(), ".env") });

const argv = process.argv.slice(2);
const flag = (name: string, fallback: string | null): string | null => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};

if (argv.includes("--help") || argv.length === 0) {
  console.log(`
Move one organization's data between cells, verifiably, with rollback until the flip.

  pnpm -C backend cell:relocate-data --org=<id> --to=cell-2 --plan
  pnpm -C backend cell:relocate-data --org=<id> --to=cell-2 --start
  pnpm -C backend cell:relocate-data --org=<id> --to=cell-2 --copy
  pnpm -C backend cell:relocate-data --org=<id> --to=cell-2 --verify
  pnpm -C backend cell:relocate-data --org=<id> --to=cell-2 --rollback
  pnpm -C backend cell:relocate-data --org=<id> --status
  pnpm -C backend cell:relocate-data --self-test

The plan is derived from pg_catalog, never from a hand-list, and --copy refuses if any tenant
table is uncovered. --verify recomputes every digest inside the target database rather than
trusting the copy, and does the same for the source so a rollback can prove nothing was lost.
`);
  process.exit(0);
}

const ORG = flag("org", null);
const TARGET_REGION = flag("to", "cell-2") ?? "cell-2";
const SELF_TEST = argv.includes("--self-test");
const LIMIT = Number(flag("limit", "0") ?? "0");

const started = Date.now();
const log = (msg: string): void =>
  console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${msg}`);

function directUrl(url: string): string {
  return /-pooler\..*\.neon\.tech/i.test(url)
    ? url.replace("-pooler.", ".")
    : url;
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function connect(url: string): Sql {
  return postgres(url, { max: 1, prepare: false, onnotice: () => {} });
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "")
    throw new Error(`${name} is required in .env`);
  return value;
}

interface Endpoints {
  readonly sourceUrl: string;
  readonly targetUrl: string;
  readonly targetDatabase: string;
}

function endpoints(): Endpoints {
  const base = directUrl(requireEnv("DATABASE_URL"));
  const targetDatabase = TARGET_REGION.replace(/-/g, "");
  const configured =
    process.env[
      `REGION_${TARGET_REGION.toUpperCase().replace(/-/g, "_")}_DATABASE_URL`
    ];
  const targetUrl =
    configured === undefined || configured === ""
      ? withDatabase(base, targetDatabase)
      : directUrl(configured);
  return { sourceUrl: base, targetUrl, targetDatabase };
}

interface RelocationRow {
  readonly relocation_id: number;
  readonly organization_id: string;
  readonly source_cell: string;
  readonly target_cell: string;
  readonly current_state: RelocationState;
  readonly tables_planned: number;
  readonly tables_copied: number;
  readonly rows_copied: number;
  readonly last_copied_table: string | null;
}

const KNOWN_STATES: ReadonlySet<string> = new Set<string>(RELOCATION_STATES);

function toRelocationState(value: unknown): RelocationState {
  const text = String(value);
  for (const state of RELOCATION_STATES) if (state === text) return state;
  throw new Error(
    `organization_relocations.current_state holds "${text}", which is not a declared` +
      ` relocation state. Known: ${[...KNOWN_STATES].join(", ")}`,
  );
}

async function activeRelocation(
  sql: Sql,
  orgId: string,
): Promise<RelocationRow | null> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT relocation_id, organization_id, source_cell, target_cell, current_state,
           tables_planned, tables_copied, rows_copied, last_copied_table
    FROM organization_relocations
    WHERE organization_id = ${orgId} AND is_active = true
    ORDER BY started_at DESC LIMIT 1`;
  const row = rows[0];
  if (row === undefined) return null;
  const lastTable = row.last_copied_table;
  return {
    relocation_id: Number(row.relocation_id),
    organization_id: String(row.organization_id),
    source_cell: String(row.source_cell),
    target_cell: String(row.target_cell),
    current_state: toRelocationState(row.current_state),
    tables_planned: Number(row.tables_planned),
    tables_copied: Number(row.tables_copied),
    rows_copied: Number(row.rows_copied),
    last_copied_table:
      lastTable === null || lastTable === undefined ? null : String(lastTable),
  };
}

async function moveTo(
  sql: Sql,
  row: RelocationRow,
  next: RelocationState,
): Promise<void> {
  assertTransitionAllowed(row.current_state, next);
  await sql`
    UPDATE organization_relocations
    SET current_state = ${next}, updated_at = now(),
        is_active = ${next !== "RETIRE_SOURCE" && next !== "ROLLED_BACK" && next !== "FAILED"}
    WHERE relocation_id = ${row.relocation_id} AND current_state = ${row.current_state}`;
  log(`${row.current_state} → ${next}`);
}

async function loadPlan(
  sql: Sql,
): Promise<{ plan: RelocationPlan; catalogNames: string[] }> {
  const catalog = await readTenantTables(sql);
  const plan = buildRelocationPlan(catalog);
  const catalogNames = catalog.map((t) => qualifiedName(t.schema, t.table));
  return { plan, catalogNames };
}

async function orderedPlan(
  sql: Sql,
  plan: RelocationPlan,
): Promise<{
  order: readonly TablePlanEntry[];
  cyclic: readonly TablePlanEntry[];
}> {
  const edges = await readForeignKeyEdges(sql);
  const { ordered, cyclic } = topologicalOrder([...plan.tables], edges);
  return { order: ordered, cyclic };
}

function assertCoverage(
  plan: RelocationPlan,
  catalogNames: readonly string[],
): void {
  const coverage = planCoverage(catalogNames, plan);
  if (coverage.uncovered.length === 0) return;
  console.error(
    `REFUSED: ${coverage.uncovered.length} tenant table(s) are not covered by the copy plan.` +
      ` A verified database beside a table that never travelled is a half-moved organization.`,
  );
  for (const t of coverage.uncovered.slice(0, 20))
    console.error(`  uncovered  ${t}`);
  process.exitCode = 1;
  throw new Error("plan coverage incomplete");
}

async function showPlan(): Promise<void> {
  const { sourceUrl } = endpoints();
  const sql = connect(sourceUrl);
  try {
    const { plan, catalogNames } = await loadPlan(sql);
    const coverage = planCoverage(catalogNames, plan);
    const partitioned = plan.tables.filter((t) => t.isPartitioned);
    console.log(`tenant tables in the catalogue : ${catalogNames.length}`);
    console.log(`tables in the copy plan        : ${plan.tables.length}`);
    console.log(
      `coverage                       : ${(coverage.coverageRatio * 100).toFixed(1)}%`,
    );
    console.log(
      `uncovered                      : ${coverage.uncovered.length}`,
    );
    console.log(`partitioned parents in the plan: ${partitioned.length}`);
    console.log(
      `object storage scopes          : ${plan.objectStoragePrefixes.length}`,
    );
    console.log(
      `search index scopes            : ${plan.searchIndexes.length}`,
    );
    console.log(
      `vector index scopes            : ${plan.vectorIndexes.length}`,
    );
    const { cyclic } = await orderedPlan(sql, plan);
    console.log(`tables in a foreign-key cycle  : ${cyclic.length}`);
    for (const t of cyclic)
      console.log(`  cyclic  ${qualifiedName(t.schema, t.table)}`);
    console.log(
      `\nRESULT: ${coverage.uncovered.length === 0 ? "PLAN COVERS EVERY TENANT TABLE" : "PLAN INCOMPLETE"}` +
        ` tables=${plan.tables.length} uncovered=${coverage.uncovered.length}`,
    );
    if (coverage.uncovered.length > 0) process.exitCode = 1;
  } finally {
    await sql.end();
  }
}

async function start(orgId: string): Promise<void> {
  const { sourceUrl } = endpoints();
  const sql = connect(sourceUrl);
  try {
    const existing = await activeRelocation(sql, orgId);
    if (existing !== null) {
      console.error(
        `REFUSED: org ${orgId} already has an active relocation in ${existing.current_state}.` +
          ` uniq_org_relocation_active makes two concurrent moves impossible by construction.`,
      );
      process.exitCode = 1;
      return;
    }
    const placement = await sql<
      { region: string; placement_version: number }[]
    >`
      SELECT region, placement_version FROM organization_placement
      WHERE organization_id = ${orgId} LIMIT 1`;
    const current = placement[0];
    if (current === undefined) {
      console.error(
        `REFUSED: org ${orgId} has no placement record; there is nothing to move.`,
      );
      process.exitCode = 1;
      return;
    }
    const { plan } = await loadPlan(sql);
    await sql`
      INSERT INTO organization_relocations
        (organization_id, source_cell, target_cell, current_state,
         placement_version_at_start, tables_planned)
      VALUES (${orgId}, ${current.region}, ${TARGET_REGION}, 'ACTIVE_SOURCE',
              ${current.placement_version}, ${plan.tables.length})`;
    console.log(
      `RESULT: RELOCATION STARTED org=${orgId} ${current.region} → ${TARGET_REGION}` +
        ` state=ACTIVE_SOURCE tables_planned=${plan.tables.length}`,
    );
  } finally {
    await sql.end();
  }
}

async function rebuildConstraints(
  target: Sql,
  breakers: readonly {
    schema: string;
    table: string;
    name: string;
    definition: string;
  }[],
  rebuilt: string[],
  failed: string[],
): Promise<void> {
  for (const b of breakers) {
    const present = await target<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_constraint k
      JOIN pg_class c ON c.oid = k.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ${b.schema} AND c.relname = ${b.table} AND k.conname = ${b.name}`;
    if ((present[0]?.n ?? 0) > 0) continue;
    try {
      await target.unsafe(
        `ALTER TABLE ${qualify(b.schema, b.table)} ADD CONSTRAINT "${b.name}" ${b.definition}`,
      );
      rebuilt.push(`${b.table}.${b.name}`);
      log(`target: rebuilt ${b.table}.${b.name}`);
    } catch (error) {
      failed.push(
        `${b.table}.${b.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

async function copy(orgId: string): Promise<void> {
  const { sourceUrl, targetUrl } = endpoints();
  const source = connect(sourceUrl);
  const target = connect(targetUrl);
  try {
    const row = await activeRelocation(source, orgId);
    if (row === null) {
      console.error(
        `REFUSED: no active relocation for org ${orgId}. Run --start first.`,
      );
      process.exitCode = 1;
      return;
    }
    if (isTerminal(row.current_state)) {
      console.error(`REFUSED: relocation is terminal in ${row.current_state}.`);
      process.exitCode = 1;
      return;
    }

    const { plan, catalogNames } = await loadPlan(source);
    assertCoverage(plan, catalogNames);
    const { order, cyclic } = await orderedPlan(source, plan);
    const primaryKeys = await readPrimaryKeyColumns(source);

    if (row.current_state === "ACTIVE_SOURCE")
      await moveTo(source, row, "SNAPSHOT");

    const breakers = await readCycleBreakers(target, cyclic);
    for (const b of breakers) {
      await target.unsafe(
        `ALTER TABLE ${qualify(b.schema, b.table)} DROP CONSTRAINT "${b.name}"`,
      );
      log(`target: dropped cycle-breaking constraint ${b.table}.${b.name}`);
    }

    const resumeAfter = row.last_copied_table;
    let skipping = resumeAfter !== null;
    let copiedTables = row.tables_copied;
    let copiedRows = row.rows_copied;
    let processed = 0;

    const rebuilt: string[] = [];
    const failed: string[] = [];
    const pending: { name: string; digest: string; rows: number }[] = [];

    try {
      await target.begin(async (tx) => {
        await tx.unsafe("SET CONSTRAINTS ALL DEFERRED");
        for (const entry of order) {
          const name = qualifiedName(entry.schema, entry.table);
          if (skipping) {
            if (name === resumeAfter) skipping = false;
            continue;
          }
          if (LIMIT > 0 && processed >= LIMIT) break;

          const pk = primaryKeys.get(name) ?? [];
          const slice = await readSlice(source, entry, orgId, pk);
          if (slice.rows > 0) {
            await writeSlice(tx, entry, slice.payload);
            log(
              `${name}: ${slice.rows} rows, digest ${slice.digest.slice(0, 12)}`,
            );
          }
          pending.push({ name, digest: slice.digest, rows: slice.rows });
          copiedTables += 1;
          copiedRows += slice.rows;
          processed += 1;
        }
      });
    } finally {
      await rebuildConstraints(target, breakers, rebuilt, failed);
    }

    for (const p of pending)
      await source`
        INSERT INTO organization_relocation_checksums
          (relocation_id, scope_kind, scope_name, source_digest, target_digest, matched)
        VALUES (${row.relocation_id}, 'table', ${p.name}, ${p.digest}, '', false)`;

    await source`
      UPDATE organization_relocations
      SET tables_copied = ${copiedTables}, rows_copied = ${copiedRows},
          last_copied_table = ${pending[pending.length - 1]?.name ?? null}, updated_at = now()
      WHERE relocation_id = ${row.relocation_id}`;

    if (failed.length > 0) {
      console.error(
        `\nRESULT: COPY INCOMPLETE — ${failed.length} constraint(s) not rebuilt`,
      );
      for (const f of failed) console.error(`  ${f}`);
      process.exitCode = 1;
      return;
    }

    console.log(
      `\nRESULT: COPIED org=${orgId} tables=${copiedTables}/${plan.tables.length}` +
        ` rows=${copiedRows} constraints_rebuilt=${rebuilt.length}`,
    );
  } finally {
    await Promise.all([source.end(), target.end()]);
  }
}

async function verify(orgId: string): Promise<void> {
  const { sourceUrl, targetUrl } = endpoints();
  const source = connect(sourceUrl);
  const target = connect(targetUrl);
  try {
    const row = await activeRelocation(source, orgId);
    if (row === null) {
      console.error(`REFUSED: no active relocation for org ${orgId}.`);
      process.exitCode = 1;
      return;
    }
    const { plan } = await loadPlan(source);
    const primaryKeys = await readPrimaryKeyColumns(source);

    const mismatches: string[] = [];
    let compared = 0;
    for (const entry of plan.tables) {
      const name = qualifiedName(entry.schema, entry.table);
      const pk = primaryKeys.get(name) ?? [];
      const from = await readDigest(source, entry, orgId, pk);
      const to = await readDigest(target, entry, orgId, pk);
      const matched = from.rows === to.rows && from.digest === to.digest;
      compared += 1;
      await source`
        UPDATE organization_relocation_checksums
        SET target_digest = ${to.digest}, matched = ${matched}, checked_at = now()
        WHERE relocation_id = ${row.relocation_id} AND scope_kind = 'table' AND scope_name = ${name}`;
      if (!matched)
        mismatches.push(
          `${name}: source rows=${from.rows} digest=${from.digest.slice(0, 12)} / target rows=${to.rows} digest=${to.digest.slice(0, 12)}`,
        );
    }

    if (mismatches.length > 0) {
      console.error(
        `\nRESULT: TARGET NOT VERIFIED — ${mismatches.length} mismatch(es) of ${compared}`,
      );
      for (const m of mismatches.slice(0, 20)) console.error(`  ${m}`);
      console.error(
        "The only legal next state after a checksum mismatch is FAILED.",
      );
      process.exitCode = 1;
      return;
    }

    console.log(
      `\nRESULT: TARGET VERIFIED BY READING org=${orgId} tables=${compared} mismatches=0`,
    );
  } finally {
    await Promise.all([source.end(), target.end()]);
  }
}

async function rollback(orgId: string): Promise<void> {
  const { sourceUrl, targetUrl } = endpoints();
  const source = connect(sourceUrl);
  const target = connect(targetUrl);
  try {
    const row = await activeRelocation(source, orgId);
    if (row === null) {
      console.error(`REFUSED: no active relocation for org ${orgId}.`);
      process.exitCode = 1;
      return;
    }
    if (!canRollback(row.current_state)) {
      console.error(
        `REFUSED: ${row.current_state} is past the placement flip. Rolling back from here is a` +
          ` new relocation in the opposite direction, not a rollback.`,
      );
      process.exitCode = 1;
      return;
    }

    const { plan } = await loadPlan(source);
    const { order, cyclic } = await orderedPlan(source, plan);
    let deleted = 0;
    for (const entry of deletionOrder(order))
      deleted += await deleteSlice(target, entry, orgId);

    const rebuilt: string[] = [];
    const failed: string[] = [];
    await rebuildConstraints(
      target,
      await readCycleBreakers(source, cyclic),
      rebuilt,
      failed,
    );
    if (failed.length > 0) {
      console.error(
        `\nRESULT: ROLLBACK INCOMPLETE — ${failed.length} constraint(s) the copy dropped could` +
          ` not be rebuilt in the target`,
      );
      for (const f of failed) console.error(`  ${f}`);
      process.exitCode = 1;
      return;
    }

    await source`
      UPDATE organization_relocations
      SET current_state = 'ROLLED_BACK', is_active = false, rollback_reason = ${"operator rollback"},
          updated_at = now()
      WHERE relocation_id = ${row.relocation_id}`;

    console.log(
      `\nRESULT: ROLLED BACK org=${orgId} from=${row.current_state}` +
        ` target_rows_deleted=${deleted} constraints_restored=${rebuilt.length}`,
    );
  } finally {
    await Promise.all([source.end(), target.end()]);
  }
}

async function status(orgId: string): Promise<void> {
  const { sourceUrl } = endpoints();
  const sql = connect(sourceUrl);
  try {
    const row = await activeRelocation(sql, orgId);
    if (row === null) {
      console.log(`no active relocation for org ${orgId}`);
      return;
    }
    const checks = await sql<{ total: number; matched: number }[]>`
      SELECT count(*)::int AS total, count(*) FILTER (WHERE matched)::int AS matched
      FROM organization_relocation_checksums WHERE relocation_id = ${row.relocation_id}`;
    console.log(`org            : ${row.organization_id}`);
    console.log(`route          : ${row.source_cell} → ${row.target_cell}`);
    console.log(`state          : ${row.current_state}`);
    console.log(`tables copied  : ${row.tables_copied}/${row.tables_planned}`);
    console.log(`rows copied    : ${row.rows_copied}`);
    console.log(`resume after   : ${row.last_copied_table ?? "(not started)"}`);
    console.log(
      `checksums      : ${checks[0]?.matched ?? 0} matched of ${checks[0]?.total ?? 0}`,
    );
    console.log(`rollback legal : ${canRollback(row.current_state)}`);
  } finally {
    await sql.end();
  }
}

function selfTest(): void {
  const failures: string[] = [];

  const plan = buildRelocationPlan([
    {
      schema: "public",
      table: "widgets",
      tenantColumn: "org_id",
      isPartitioned: false,
    },
    {
      schema: "public",
      table: "organization_placement",
      tenantColumn: "organization_id",
      isPartitioned: false,
    },
  ]);
  if (plan.tables.length !== 1)
    failures.push("control-plane routing state was not excluded from the plan");

  const coverage = planCoverage(["public.widgets", "public.orphan"], plan);
  if (coverage.uncovered.length !== 1)
    failures.push("an uncovered tenant table was not reported");

  try {
    assertTransitionAllowed("FLIP_PLACEMENT", "ROLLED_BACK");
    failures.push("a rollback after the flip was allowed");
  } catch {
    // the transition table refuses it, which is the property under test
  }

  if (canRollback("ACTIVE_TARGET"))
    failures.push("canRollback allowed a post-flip state");
  if (!canRollback("VERIFY_TARGET"))
    failures.push("canRollback refused a pre-flip state");

  if (failures.length === 0) {
    console.log(
      "SELF-TEST PASS: routing state is excluded, an uncovered table is reported, and a" +
        " post-flip rollback is refused",
    );
    return;
  }
  for (const f of failures) console.error(`SELF-TEST FAIL: ${f}`);
  process.exitCode = 1;
}

async function main(): Promise<void> {
  if (SELF_TEST) return selfTest();
  if (argv.includes("--plan")) return showPlan();

  if (ORG === null) {
    console.error("--org=<organization id> is required");
    process.exitCode = 1;
    return;
  }
  if (argv.includes("--start")) return start(ORG);
  if (argv.includes("--copy")) return copy(ORG);
  if (argv.includes("--verify")) return verify(ORG);
  if (argv.includes("--rollback")) return rollback(ORG);
  if (argv.includes("--status")) return status(ORG);

  console.error(
    "Pick one of --plan, --start, --copy, --verify, --rollback, --status, --self-test.",
  );
  process.exitCode = 1;
}

main().catch((e) => {
  console.error("RELOCATION FAILED:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
