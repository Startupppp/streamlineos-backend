/**
 * The pg_catalog half of the PRD-C057 inventory: every in-scope column, primary
 * key, foreign key, unique constraint, check and index at journal head, plus the
 * two facts a verdict needs that no single catalog view carries — whether a
 * foreign key's child columns are covered by an index that LEADS with them, and
 * whether a unique on a tenant-owned table carries the tenant column.
 */

export const COLUMNS_QUERY = `
  select c.table_schema as schema, c.table_name as tbl, c.column_name as col,
         c.data_type as data_type, c.is_nullable as nullable, coalesce(c.column_default, '') as col_default
  from information_schema.columns c
  join pg_class pc on pc.relname = c.table_name
  join pg_namespace pn on pn.oid = pc.relnamespace and pn.nspname = c.table_schema
  where c.table_schema not in ('pg_catalog', 'information_schema', 'drizzle')
    and pc.relkind in ('r', 'p')
    and pc.relispartition = false
  order by 1, 2, 3
`;

export const CONSTRAINTS_QUERY = `
  select n.nspname as schema, c.relname as tbl, co.conname as name, co.contype::text as kind,
         pg_get_constraintdef(co.oid) as definition,
         coalesce((select string_agg(a.attname, ',' order by k.ord)
                   from unnest(co.conkey) with ordinality k(attnum, ord)
                   join pg_attribute a on a.attrelid = co.conrelid and a.attnum = k.attnum), '') as cols,
         coalesce(pn.nspname || '.' || pc.relname, '') as parent,
         exists(select 1 from pg_attribute a
                where a.attrelid = co.conrelid and a.attname in ('org_id', 'organization_id')) as table_is_tenant_owned
  from pg_constraint co
  join pg_class c on c.oid = co.conrelid
  join pg_namespace n on n.oid = c.relnamespace
  left join pg_class pc on pc.oid = co.confrelid
  left join pg_namespace pn on pn.oid = pc.relnamespace
  where co.contype in ('p', 'f', 'u', 'c')
    and n.nspname not in ('pg_catalog', 'information_schema', 'drizzle')
    and c.relispartition = false
  order by 1, 2, 3
`;

export const INDEXES_QUERY = `
  select n.nspname as schema, c.relname as tbl, ic.relname as name,
         i.indisunique as is_unique, i.indisprimary as is_primary,
         exists(select 1 from pg_constraint co where co.conindid = i.indexrelid) as backs_constraint,
         coalesce(pg_get_expr(i.indpred, i.indrelid), '') as predicate,
         pg_get_indexdef(i.indexrelid) as definition,
         coalesce((select string_agg(a.attname, ',' order by k.ord)
                   from unnest((i.indkey::int2[])[0:i.indnkeyatts - 1]) with ordinality k(attnum, ord)
                   join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum), '') as cols,
         coalesce(si.idx_scan, 0)::int as idx_scan
  from pg_index i
  join pg_class ic on ic.oid = i.indexrelid
  join pg_class c on c.oid = i.indrelid
  join pg_namespace n on n.oid = c.relnamespace
  left join pg_stat_user_indexes si on si.indexrelid = i.indexrelid
  where n.nspname not in ('pg_catalog', 'information_schema', 'drizzle')
    and c.relispartition = false
    and i.indisvalid
  order by 1, 2, 3
`;

/** Leading-column coverage: an index answers a foreign key only when the key's columns are a leading prefix of it. */
export function foreignKeyIsCovered(foreignKey, indexes) {
  const wanted = foreignKey.cols.split(",");
  return indexes.some((index) => {
    if (index.schema !== foreignKey.schema || index.tbl !== foreignKey.tbl) return false;
    if (index.predicate !== "") return false;
    const columns = index.cols === "" ? [] : index.cols.split(",");
    if (columns.length < wanted.length) return false;
    return wanted.every((column, position) => columns[position] === column);
  });
}
