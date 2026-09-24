import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const FUNCTION_NAME = "bump_report_revision";
const CHANGED_ROW_ALIAS = "c";

export function extractFunctionBody(sql) {
  const start = sql.indexOf(`FUNCTION build.${FUNCTION_NAME}`);
  if (start === -1) return null;
  const open = sql.indexOf("$$", start);
  if (open === -1) return null;
  const close = sql.indexOf("$$", open + 2);
  if (close === -1) return null;
  return sql.slice(open + 2, close);
}

export function extractTriggerTargets(sql) {
  const targets = new Set();
  const loop = /FOREACH\s+\w+\s+IN\s+ARRAY\s+ARRAY\[([^\]]*)\]/i.exec(sql);
  if (loop) for (const m of loop[1].matchAll(/'([^']+)'/g)) targets.add(m[1]);
  const attached =
    /CREATE\s+TRIGGER\s+build_report_revision_\w+\s+(?:AFTER|BEFORE)[^;]*?\sON\s+"?([a-z_]+)"?\."?([a-z_]+)"?/gi;
  let match;
  while ((match = attached.exec(sql)) !== null)
    targets.add(`${match[1].toLowerCase()}.${match[2].toLowerCase()}`);
  return [...targets];
}

export function extractAliasBindings(body) {
  const bindings = new Map();
  const pattern = /\b(?:FROM|JOIN)\s+([a-z_]+)\.([a-z_]+)\s+([a-z][a-z0-9_]*)/gi;
  let match;
  while ((match = pattern.exec(body)) !== null) {
    const alias = match[3].toLowerCase();
    if (["on", "as", "where", "and", "set", "from", "join"].includes(alias)) continue;
    bindings.set(alias, `${match[1]}.${match[2]}`);
  }
  return bindings;
}

export function splitTableBranches(body) {
  const branches = [];
  const pattern = /(?:IF|ELSIF)\s+TG_TABLE_NAME\s*=\s*'([a-z_]+)'\s+THEN/gi;
  const markers = [...body.matchAll(pattern)];
  for (let i = 0; i < markers.length; i++) {
    const start = markers[i].index + markers[i][0].length;
    const end = i + 1 < markers.length ? markers[i + 1].index : body.length;
    branches.push({ table: markers[i][1].toLowerCase(), start, end });
  }
  return branches;
}

export function extractColumnReferences(body) {
  const branches = splitTableBranches(body);
  const refs = [];
  const pattern = /\b([a-z][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\b/g;
  let match;
  while ((match = pattern.exec(body)) !== null) {
    const qualifier = match[1].toLowerCase();
    const column = match[2].toLowerCase();
    if (["build", "build_events", "pg_catalog", "public"].includes(qualifier)) continue;
    const branch = branches.find((b) => match.index >= b.start && match.index < b.end);
    refs.push({ qualifier, column, onlyForTable: branch ? branch.table : null });
  }
  return refs;
}

export function extractPendingRenames(files) {
  const renamedTables = new Map();
  for (const { path, source } of files) {
    const pattern =
      /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?"?([a-z_]+)"?\."?([a-z_]+)"?\s+RENAME\s+TO\s+"?([a-z_]+)"?/gi;
    let match;
    while ((match = pattern.exec(source)) !== null) {
      const from = `${match[1].toLowerCase()}.${match[2].toLowerCase()}`;
      renamedTables.set(from, { to: `${match[1].toLowerCase()}.${match[3].toLowerCase()}`, path });
    }
  }
  return renamedTables;
}

export function extractPendingDrops(files) {
  const droppedTables = new Map();
  const droppedColumns = new Map();
  for (const { path, source } of files) {
    const tablePattern = /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?"?([a-z_]+)"?\."?([a-z_]+)"?/gi;
    let match;
    while ((match = tablePattern.exec(source)) !== null) {
      const table = `${match[1].toLowerCase()}.${match[2].toLowerCase()}`;
      droppedTables.set(table, path);
    }
    const columnPattern =
      /ALTER\s+TABLE\s+"?([a-z_]+)"?\."?([a-z_]+)"?\s+DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?"?([a-z_]+)"?/gi;
    while ((match = columnPattern.exec(source)) !== null) {
      const key = `${match[1].toLowerCase()}.${match[2].toLowerCase()}.${match[3].toLowerCase()}`;
      droppedColumns.set(key, path);
    }
  }
  return { droppedTables, droppedColumns };
}

export function analyse({ definitionSql, pendingFiles, targetSources = [] }) {
  const body = extractFunctionBody(definitionSql);
  if (body === null) return { error: "no bump_report_revision function body found" };

  const targets = [
    ...new Set(
      [definitionSql, ...targetSources].flatMap((sql) => extractTriggerTargets(sql)),
    ),
  ];
  if (targets.length === 0)
    return { error: "no trigger targets resolved — the column checks would pass vacuously" };
  const aliases = extractAliasBindings(body);
  const references = extractColumnReferences(body);
  const { droppedTables, droppedColumns } = extractPendingDrops(pendingFiles);
  const renamedTables = extractPendingRenames(pendingFiles);

  const findings = [];

  for (const [alias, table] of aliases) {
    const droppedBy = droppedTables.get(table);
    if (droppedBy)
      findings.push({
        kind: "table-dropped",
        table,
        alias,
        droppedBy,
      });
    const renamed = renamedTables.get(table);
    if (renamed)
      findings.push({
        kind: "table-renamed",
        table,
        alias,
        renamedTo: renamed.to,
        droppedBy: renamed.path,
      });
  }

  for (const target of targets) {
    const renamed = renamedTables.get(target);
    if (!renamed) continue;
    const oldName = target.split(".")[1];
    const newName = renamed.to.split(".")[1];
    if (!body.includes(`'${oldName}'`)) continue;
    if (body.includes(`'${newName}'`)) continue;
    findings.push({
      kind: "trigger-target-renamed",
      table: target,
      renamedTo: renamed.to,
      droppedBy: renamed.path,
    });
  }

  const seen = new Set();
  for (const { qualifier, column, onlyForTable } of references) {
    const bound = aliases.get(qualifier);
    let candidateTables = bound ? [bound] : qualifier === CHANGED_ROW_ALIAS ? targets : [];
    if (!bound && onlyForTable !== null)
      candidateTables = candidateTables.filter(
        (table) => table.split(".")[1] === onlyForTable,
      );
    for (const table of candidateTables) {
      const key = `${table}.${column}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const droppedBy = droppedColumns.get(key);
      if (droppedBy)
        findings.push({
          kind: "column-dropped",
          table,
          column,
          alias: qualifier,
          droppedBy,
        });
    }
  }

  return { body, targets, aliases, references, findings };
}

function loadPendingFiles(root) {
  const dir = join(root, "migrations", "sql");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".sql") && !name.includes("-rollback"))
    .map((name) => ({
      path: relative(root, join(dir, name)).split(sep).join("/"),
      source: readFileSync(join(dir, name), "utf8"),
    }));
}

export function pickEffectiveDefinition(candidates) {
  const defining = candidates.filter((c) => c.source.includes(`FUNCTION build.${FUNCTION_NAME}`));
  if (defining.length === 0) return null;
  const order = (name) => {
    const match = /^(\d+)/.exec(name);
    return match ? Number(match[1]) : -1;
  };
  return defining.reduce((best, current) =>
    order(current.name) > order(best.name) ? current : best,
  );
}

function loadDefinition(root) {
  const dir = join(root, "migrations");
  const candidates = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".sql")) continue;
    candidates.push({ name, source: readFileSync(join(dir, name), "utf8") });
  }
  const effective = pickEffectiveDefinition(candidates);
  if (!effective) return null;
  const superseded = candidates.filter(
    (c) => c.source.includes(`FUNCTION build.${FUNCTION_NAME}`) && c.name !== effective.name,
  );
  return {
    path: relative(root, join(dir, effective.name)).split(sep).join("/"),
    source: effective.source,
    supersededCount: superseded.length,
    targetSources: candidates
      .filter((c) => c.name !== effective.name && c.source.includes(FUNCTION_NAME))
      .map((c) => c.source),
  };
}

const DEFINITION_FIXTURE = `
CREATE FUNCTION build.bump_report_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'sprint_scope_events' THEN
    affected := 'SELECT DISTINCT c.org_id, s.project_id FROM (' || changed || ') c JOIN build.sprints s ON s.org_id = c.org_id AND s.id = c.sprint_id';
  END IF;
END;
$$;
DO $$
BEGIN
  FOREACH target IN ARRAY ARRAY['build.tickets', 'build_events.sprint_scope_events'] LOOP
  END LOOP;
END;
$$;
`;

const SELF_TEST_CASES = [
  {
    name: "a column the dynamic SQL reads is reported when pending DDL drops it",
    input: {
      definitionSql: DEFINITION_FIXTURE,
      pendingFiles: [
        {
          path: "detach.sql",
          source: 'ALTER TABLE "build_events"."sprint_scope_events" DROP COLUMN IF EXISTS "sprint_id";',
        },
      ],
    },
    expect: (r) =>
      r.findings.some(
        (f) =>
          f.kind === "column-dropped" &&
          f.table === "build_events.sprint_scope_events" &&
          f.column === "sprint_id",
      ),
  },
  {
    name: "a table the dynamic SQL joins is reported when pending DDL drops it",
    input: {
      definitionSql: DEFINITION_FIXTURE,
      pendingFiles: [{ path: "drop.sql", source: 'DROP TABLE "build"."sprints";' }],
    },
    expect: (r) => r.findings.some((f) => f.kind === "table-dropped" && f.table === "build.sprints"),
  },
  {
    name: "unrelated pending DDL produces no finding",
    input: {
      definitionSql: DEFINITION_FIXTURE,
      pendingFiles: [
        { path: "other.sql", source: 'ALTER TABLE "build"."projects" DROP COLUMN IF EXISTS "nickname";' },
      ],
    },
    expect: (r) => r.findings.length === 0,
  },
  {
    name: "the trigger target list is read from the FOREACH array",
    input: { definitionSql: DEFINITION_FIXTURE, pendingFiles: [] },
    expect: (r) =>
      r.targets.length === 2 && r.targets.includes("build_events.sprint_scope_events"),
  },
  {
    name: "a join alias is bound to its schema-qualified table",
    input: { definitionSql: DEFINITION_FIXTURE, pendingFiles: [] },
    expect: (r) => r.aliases.get("s") === "build.sprints",
  },
  {
    name: "rollback scripts are not treated as pending DDL by the loader filter",
    input: {
      definitionSql: DEFINITION_FIXTURE,
      pendingFiles: [],
    },
    expect: (r) => r.findings.length === 0,
  },
  {
    name: "a definition without the function is reported rather than passing vacuously",
    input: { definitionSql: "SELECT 1;", pendingFiles: [] },
    expect: (r) => typeof r.error === "string",
  },
  {
    name: "a definition that resolves no trigger target errors instead of passing vacuously",
    input: {
      definitionSql:
        "CREATE OR REPLACE FUNCTION build.bump_report_revision() RETURNS trigger AS $$ BEGIN affected := 'SELECT c.org_id FROM (x) c'; END; $$;",
      pendingFiles: [],
    },
    expect: (r) => typeof r.error === "string" && r.error.includes("vacuously"),
  },
  {
    name: "a target attached by CREATE TRIGGER is recovered, not only ones listed in a FOREACH array",
    input: {
      definitionSql:
        "CREATE OR REPLACE FUNCTION build.bump_report_revision() RETURNS trigger AS $$ BEGIN affected := 'SELECT c.cycle_id FROM (x) c'; END; $$;\nCREATE TRIGGER build_report_revision_insert AFTER INSERT ON build.cycles REFERENCING NEW TABLE AS changed_new FOR EACH STATEMENT EXECUTE FUNCTION build.bump_report_revision();",
      pendingFiles: [
        { path: "hypothetical.sql", source: 'ALTER TABLE "build"."cycles" DROP COLUMN IF EXISTS "cycle_id";' },
      ],
    },
    expect: (r) =>
      r.targets.includes("build.cycles") &&
      r.findings.some((f) => f.kind === "column-dropped" && f.table === "build.cycles"),
  },
  {
    name: "the highest-numbered migration defining the function wins, so a replacement is not shadowed by the original",
    input: { definitionSql: DEFINITION_FIXTURE, pendingFiles: [] },
    expect: () => {
      const chosen = pickEffectiveDefinition([
        { name: "1073_build_report_revision.sql", source: "CREATE FUNCTION build.bump_report_revision() old" },
        { name: "1152_build_report_revision_cycles.sql", source: "CREATE OR REPLACE FUNCTION build.bump_report_revision() new" },
        { name: "0500_unrelated.sql", source: "SELECT 1;" },
      ]);
      return chosen !== null && chosen.name === "1152_build_report_revision_cycles.sql";
    },
  },
  {
    name: "a pending RENAME of a trigger target is reported, because TG_TABLE_NAME stops matching and the branch falls through",
    input: {
      definitionSql: DEFINITION_FIXTURE,
      pendingFiles: [
        {
          path: "rename.sql",
          source: 'ALTER TABLE "build_events"."sprint_scope_events" RENAME TO "cycle_scope_events";',
        },
      ],
    },
    expect: (r) =>
      r.findings.some(
        (f) =>
          f.kind === "trigger-target-renamed" &&
          f.table === "build_events.sprint_scope_events" &&
          f.renamedTo === "build_events.cycle_scope_events",
      ),
  },
  {
    name: "a branch that matches both the old and the new name is not reported, because the rename cannot break it",
    input: {
      definitionSql: DEFINITION_FIXTURE.replace(
        "IF TG_TABLE_NAME = 'sprint_scope_events' THEN",
        "IF TG_TABLE_NAME IN ('sprint_scope_events', 'cycle_scope_events') THEN",
      ),
      pendingFiles: [
        {
          path: "rename.sql",
          source: 'ALTER TABLE "build_events"."sprint_scope_events" RENAME TO "cycle_scope_events";',
        },
      ],
    },
    expect: (r) => !r.findings.some((f) => f.kind === "trigger-target-renamed"),
  },
  {
    name: "a RENAME of a table the body joins is reported separately from a branch rename",
    input: {
      definitionSql: DEFINITION_FIXTURE,
      pendingFiles: [
        { path: "rename.sql", source: 'ALTER TABLE "build"."sprints" RENAME TO "legacy_sprints";' },
      ],
    },
    expect: (r) =>
      r.findings.some((f) => f.kind === "table-renamed" && f.table === "build.sprints"),
  },
  {
    name: "a column read only inside a TG_TABLE_NAME branch is not charged to the other trigger targets",
    input: {
      definitionSql: DEFINITION_FIXTURE,
      pendingFiles: [
        {
          path: "detach.sql",
          source:
            'ALTER TABLE "build"."tickets" DROP COLUMN IF EXISTS "sprint_id";\nALTER TABLE "build_events"."sprint_scope_events" DROP COLUMN IF EXISTS "sprint_id";',
        },
      ],
    },
    expect: (r) =>
      r.findings.filter((f) => f.kind === "column-dropped").length === 1 &&
      r.findings.some((f) => f.table === "build_events.sprint_scope_events"),
  },
];

export function runSelfTest() {
  const failures = [];
  for (const testCase of SELF_TEST_CASES) {
    let result;
    try {
      result = analyse(testCase.input);
    } catch (err) {
      failures.push(`${testCase.name} (threw: ${String(err)})`);
      continue;
    }
    if (!testCase.expect(result)) failures.push(testCase.name);
  }
  return failures;
}

function main(argv) {
  if (argv.includes("--self-test")) {
    const failures = runSelfTest();
    if (failures.length) {
      for (const name of failures) console.error(`  FAIL  ${name}`);
      console.error(`self-test FAILED — ${String(failures.length)} case(s)`);
      return 1;
    }
    console.log(`self-test passed — ${String(SELF_TEST_CASES.length)} case(s)`);
    return 0;
  }

  const root = process.cwd();
  const definition = loadDefinition(root);
  if (!definition) {
    console.error(`no migration defines build.${FUNCTION_NAME}`);
    return 1;
  }
  const pendingFiles = loadPendingFiles(root);
  const result = analyse({
    definitionSql: definition.source,
    pendingFiles,
    targetSources: definition.targetSources,
  });
  if (result.error) {
    console.error(result.error);
    return 1;
  }

  console.log(`=== build report-revision trigger integrity ===`);
  console.log(
    `definition      ${definition.path}${definition.supersededCount ? ` (supersedes ${String(definition.supersededCount)} earlier definition(s))` : ""}`,
  );
  console.log(`trigger targets ${result.targets.join(", ")}`);
  console.log(`pending scripts ${String(pendingFiles.length)} in migrations/sql`);

  if (!result.findings.length) {
    console.log("");
    console.log("PASS — no pending script removes a table or column the trigger body reaches.");
    return 0;
  }

  console.log("");
  console.log("BROKEN BY PENDING DDL (dynamic SQL records no dependency, so the DROP will succeed):");
  for (const finding of result.findings) {
    if (finding.kind === "table-dropped")
      console.log(`  TABLE   ${finding.table} (alias ${finding.alias}) dropped by ${finding.droppedBy}`);
    else if (finding.kind === "table-renamed")
      console.log(
        `  RENAME  ${finding.table} (alias ${finding.alias}) becomes ${finding.renamedTo} in ${finding.droppedBy}`,
      );
    else if (finding.kind === "trigger-target-renamed")
      console.log(
        `  BRANCH  TG_TABLE_NAME '${finding.table.split(".")[1]}' becomes '${finding.renamedTo.split(".")[1]}' in ${finding.droppedBy} — the branch stops matching and falls through`,
      );
    else
      console.log(
        `  COLUMN  ${finding.table}.${finding.column} (alias ${finding.alias}) dropped by ${finding.droppedBy}`,
      );
  }
  console.log("");
  console.log(
    `FAIL — ${String(result.findings.length)} dangling reference(s) in build.${FUNCTION_NAME}.`,
  );
  return 1;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
