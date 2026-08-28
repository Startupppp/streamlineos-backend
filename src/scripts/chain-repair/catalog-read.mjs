import postgres from "postgres";

export const SYSTEM_SCHEMAS = ["pg_catalog", "information_schema", "pg_toast", "drizzle"];

export function connect(url) {
  return postgres(url, { max: 1, prepare: false, onnotice: () => {} });
}

async function schemas(sql) {
  const rows = await sql`
    SELECT nspname AS name FROM pg_namespace
    WHERE nspname <> ALL(${SYSTEM_SCHEMAS}) AND nspname NOT LIKE 'pg_%'`;
  return rows.map((r) => ({ key: String(r.name), name: String(r.name) }));
}

async function tables(sql) {
  const rows = await sql`
    SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind,
           pg_get_partkeydef(c.oid) AS partkey,
           pg_get_expr(c.relpartbound, c.oid) AS partbound,
           (SELECT pn.nspname || '.' || pc.relname FROM pg_inherits i
              JOIN pg_class pc ON pc.oid = i.inhparent
              JOIN pg_namespace pn ON pn.oid = pc.relnamespace
             WHERE i.inhrelid = c.oid LIMIT 1) AS parent
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p') AND n.nspname <> ALL(${SYSTEM_SCHEMAS})`;
  return rows.map((r) => ({
    key: `${r.schema}.${r.name}`,
    schema: String(r.schema),
    name: String(r.name),
    kind: String(r.kind),
    partkey: r.partkey === null ? null : String(r.partkey),
    partbound: r.partbound === null ? null : String(r.partbound),
    parent: r.parent === null ? null : String(r.parent),
  }));
}

async function columns(sql) {
  const rows = await sql`
    SELECT n.nspname AS schema, c.relname AS table, a.attname AS name, a.attnum AS ord,
           format_type(a.atttypid, a.atttypmod) AS type,
           a.attnotnull AS notnull, a.attidentity AS identity, a.attgenerated AS generated,
           pg_get_expr(d.adbin, d.adrelid) AS default_expr,
           (SELECT cl.collname FROM pg_collation cl
             WHERE cl.oid = a.attcollation AND a.attcollation <> t.typcollation) AS collation
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_type t ON t.oid = a.atttypid
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
      AND n.nspname <> ALL(${SYSTEM_SCHEMAS})
    ORDER BY n.nspname, c.relname, a.attnum`;
  return rows.map((r) => ({
    key: `${r.schema}.${r.table}.${r.name}:${r.type}:${r.notnull}`,
    nameKey: `${r.schema}.${r.table}.${r.name}`,
    tableKey: `${r.schema}.${r.table}`,
    schema: String(r.schema),
    table: String(r.table),
    name: String(r.name),
    ord: Number(r.ord),
    type: String(r.type),
    notnull: r.notnull === true,
    identity: String(r.identity ?? ""),
    generated: String(r.generated ?? ""),
    defaultExpr: r.default_expr === null ? null : String(r.default_expr),
    collation: r.collation === null ? null : String(r.collation),
  }));
}

async function enums(sql) {
  const rows = await sql`
    SELECT n.nspname AS schema, t.typname AS name, e.enumlabel AS label, e.enumsortorder AS ord
    FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    ORDER BY t.typname, e.enumsortorder`;
  return rows.map((r) => ({
    key: `${r.name}:${r.label}`,
    typeKey: `${r.schema}.${r.name}`,
    schema: String(r.schema),
    name: String(r.name),
    label: String(r.label),
    ord: Number(r.ord),
  }));
}

async function functions(sql) {
  const rows = await sql`
    SELECT n.nspname AS schema, p.proname AS name, p.prokind AS kind,
           CASE WHEN p.prokind IN ('f', 'p') THEN pg_get_functiondef(p.oid) ELSE NULL END AS def,
           pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname <> ALL(${SYSTEM_SCHEMAS})`;
  return rows.map((r) => ({
    key: `${r.schema}.${r.name}`,
    schema: String(r.schema),
    name: String(r.name),
    kind: String(r.kind),
    args: String(r.args ?? ""),
    def: r.def === null ? null : String(r.def),
  }));
}

async function constraints(sql) {
  const rows = await sql`
    SELECT n.nspname AS schema, c.relname AS table, k.conname AS name,
           k.contype::text AS type, pg_get_constraintdef(k.oid) AS def
    FROM pg_constraint k
    JOIN pg_class c ON c.oid = k.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname <> ALL(${SYSTEM_SCHEMAS})`;
  return rows.map((r) => ({
    key: `${r.schema}.${r.table}.${r.name}:${r.type}`,
    tableKey: `${r.schema}.${r.table}`,
    schema: String(r.schema),
    table: String(r.table),
    name: String(r.name),
    type: String(r.type),
    def: String(r.def),
  }));
}

async function indexes(sql) {
  const rows = await sql`
    SELECT n.nspname AS schema, t.relname AS table, i.relname AS name,
           pg_get_indexdef(x.indexrelid) AS def,
           EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = x.indexrelid) AS backs_constraint
    FROM pg_index x
    JOIN pg_class i ON i.oid = x.indexrelid
    JOIN pg_class t ON t.oid = x.indrelid
    JOIN pg_namespace n ON n.oid = i.relnamespace
    WHERE n.nspname <> ALL(${SYSTEM_SCHEMAS})`;
  return rows.map((r) => ({
    key: `${r.schema}.${r.name}`,
    tableKey: `${r.schema}.${r.table}`,
    schema: String(r.schema),
    table: String(r.table),
    name: String(r.name),
    def: String(r.def),
    backsConstraint: r.backs_constraint === true,
  }));
}

async function triggers(sql) {
  const rows = await sql`
    SELECT n.nspname AS schema, c.relname AS table, t.tgname AS name,
           pg_get_triggerdef(t.oid) AS def
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE NOT t.tgisinternal AND n.nspname <> ALL(${SYSTEM_SCHEMAS})`;
  return rows.map((r) => ({
    key: `${r.schema}.${r.table}.${r.name}`,
    tableKey: `${r.schema}.${r.table}`,
    schema: String(r.schema),
    table: String(r.table),
    name: String(r.name),
    def: String(r.def),
  }));
}

async function policies(sql) {
  const rows = await sql`
    SELECT schemaname AS schema, tablename AS table, policyname AS name,
           permissive, roles, cmd, qual, with_check
    FROM pg_policies`;
  return rows.map((r) => ({
    key: `${r.schema}.${r.table}.${r.name}`,
    tableKey: `${r.schema}.${r.table}`,
    schema: String(r.schema),
    table: String(r.table),
    name: String(r.name),
    permissive: String(r.permissive),
    roles: Array.isArray(r.roles) ? r.roles.map((x) => String(x)) : [],
    cmd: String(r.cmd),
    qual: r.qual === null ? null : String(r.qual),
    withCheck: r.with_check === null ? null : String(r.with_check),
  }));
}

async function rlsEnabled(sql) {
  const rows = await sql`
    SELECT n.nspname AS schema, c.relname AS name
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relrowsecurity AND n.nspname <> ALL(${SYSTEM_SCHEMAS})`;
  return rows.map((r) => ({
    key: `${r.schema}.${r.name}`,
    schema: String(r.schema),
    name: String(r.name),
  }));
}


async function sequences(sql) {
  const rows = await sql`
    SELECT n.nspname AS schema, c.relname AS name,
           s.seqstart AS start, s.seqincrement AS increment,
           s.seqmin AS minvalue, s.seqmax AS maxvalue, s.seqcache AS cache,
           s.seqcycle AS cycle, format_type(s.seqtypid, NULL) AS type,
           (SELECT dn.nspname || '.' || dc.relname || '.' || a.attname
              FROM pg_depend d
              JOIN pg_class dc ON dc.oid = d.refobjid
              JOIN pg_namespace dn ON dn.oid = dc.relnamespace
              JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
             WHERE d.objid = c.oid AND d.classid = 'pg_class'::regclass
               AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')
             LIMIT 1) AS owned_by
    FROM pg_sequence s
    JOIN pg_class c ON c.oid = s.seqrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname <> ALL(${SYSTEM_SCHEMAS})`;
  return rows.map((r) => ({
    key: `${r.schema}.${r.name}`,
    schema: String(r.schema),
    name: String(r.name),
    type: String(r.type),
    start: String(r.start),
    increment: String(r.increment),
    minvalue: String(r.minvalue),
    maxvalue: String(r.maxvalue),
    cache: String(r.cache),
    cycle: r.cycle === true,
    ownedBy: r.owned_by === null ? null : String(r.owned_by),
  }));
}

export const READERS = {
  schemas,
  sequences,
  enums,
  tables,
  columns,
  functions,
  constraints,
  indexes,
  triggers,
  policies,
  rlsEnabled,
};

export async function readCatalog(url) {
  const sql = connect(url);
  try {
    const out = {};
    for (const [name, reader] of Object.entries(READERS)) out[name] = await reader(sql);
    return out;
  } finally {
    await sql.end();
  }
}
