/**
 * Catalog shapes and the pg_catalog / statistics reads behind
 * `check:redundant-objects`. Split out of the entry script under CLAUDE.md §7;
 * the entry file carries the defect narrative.
 *
 * The key signature is `pg_get_indexdef(indexrelid, k, false) || ':' || indoption[k-1]`
 * per key attribute. Both halves matter. Dropping the expression loses opclass
 * and expression indexes; dropping `indoption` loses ASC/DESC and NULLS
 * FIRST/LAST, and that is not cosmetic — `(org_id, effective_from)` and
 * `(org_id, effective_from DESC)` are DIFFERENT access paths for an unbounded
 * `ORDER BY`, which is exactly the "ordering" the criterion says to preserve.
 * A detector that compares `indkey` alone calls all three of this repo's
 * DESC-trailing pairs exact duplicates. They are not.
 */

export interface LiveIndex {
  readonly schema: string;
  readonly tbl: string;
  readonly name: string;
  readonly am: string;
  readonly is_unique: boolean;
  readonly is_primary: boolean;
  readonly backs_constraint: boolean;
  readonly predicate: string;
  readonly keydef: string;
  readonly includedef: string;
  readonly idx_scan: number;
  readonly n_live_tup: number;
  /** This index is the reference target of at least one live foreign key. */
  readonly is_fk_target: boolean;
  /** Its key vector leads with the tenant column, so AR-02 composite keys land on it. */
  readonly leads_with_tenant: boolean;
}

export interface LiveConstraint {
  readonly schema: string;
  readonly tbl: string;
  readonly name: string;
  /** `f` foreign key · `u` unique · `c` check. */
  readonly kind: string;
  readonly signature: string;
  readonly definition: string;
  /** Sorted attribute numbers, so subset comparison is order-independent. */
  readonly colset: string;
  /** `schema.table` of the referenced relation, empty for a unique or a check. */
  readonly parent: string;
  /** `confupdtype||confdeltype`, empty for a unique or a check. */
  readonly actions: string;
}

export type Verdict = "REDUNDANT" | "PRESERVE";

export type PreserveReason =
  | "backs-a-constraint"
  | "primary-key"
  | "distinct-uniqueness-guarantee"
  | "distinct-ordering"
  | "distinct-predicate"
  | "documented-access-pattern"
  | "referenced-by-a-foreign-key"
  | "tenant-anchored-fk-target"
  | "distinct-referential-action"
  | "implied-by-composite";

export interface Overlap {
  readonly id: string;
  readonly kind: "index" | "foreign-key" | "unique" | "check";
  readonly schema: string;
  readonly tbl: string;
  /** The object a removal would target. */
  readonly candidate: string;
  /** The object that would survive and answer the candidate's access pattern. */
  readonly survivor: string;
  readonly relation: "exact-duplicate" | "leading-prefix";
  /** The candidate's key vector, so plan capture never has to parse `detail`. */
  readonly candidateKeys: string;
  readonly verdict: Verdict;
  readonly preserveReason: PreserveReason | null;
  readonly detail: string;
  /** Attached for the report only. Never read by the verdict — see detect.ts. */
  readonly candidateScans: number;
  readonly survivorScans: number;
  readonly rows: number;
}

export const LIVE_INDEXES_QUERY = `
  select n.nspname as schema,
         c.relname as tbl,
         ic.relname as name,
         am.amname as am,
         i.indisunique as is_unique,
         i.indisprimary as is_primary,
         exists(select 1 from pg_constraint co where co.conindid = i.indexrelid) as backs_constraint,
         coalesce(pg_get_expr(i.indpred, i.indrelid), '') as predicate,
         array_to_string(array(
           select pg_get_indexdef(i.indexrelid, k, false) || ':' || (i.indoption)[k - 1]::text
           from generate_series(1, i.indnkeyatts) k
         ), ',') as keydef,
         array_to_string(array(
           select pg_get_indexdef(i.indexrelid, k, false)
           from generate_series(i.indnkeyatts + 1, i.indnatts) k
         ), ',') as includedef,
         coalesce(si.idx_scan, 0)::int as idx_scan,
         coalesce(st.n_live_tup, 0)::int as n_live_tup,
         exists(select 1 from pg_constraint fk where fk.contype = 'f' and fk.conindid = i.indexrelid) as is_fk_target,
         exists(
           select 1 from pg_attribute a
           where a.attrelid = i.indrelid
             and a.attnum = (i.indkey::int2[])[0]
             and a.attname in ('org_id', 'organization_id')
         ) as leads_with_tenant
  from pg_index i
  join pg_class ic on ic.oid = i.indexrelid
  join pg_class c on c.oid = i.indrelid
  join pg_namespace n on n.oid = c.relnamespace
  join pg_am am on am.oid = ic.relam
  left join pg_stat_user_indexes si on si.indexrelid = i.indexrelid
  left join pg_stat_user_tables st on st.relid = i.indrelid
  where n.nspname not in ('pg_catalog', 'information_schema', 'drizzle')
    and c.relispartition = false
    and i.indisvalid
  order by n.nspname, c.relname, ic.relname
`;

export const LIVE_CONSTRAINTS_QUERY = `
  select n.nspname as schema,
         c.relname as tbl,
         co.conname as name,
         co.contype::text as kind,
         case co.contype
           when 'f' then co.conkey::text || '->' || co.confrelid::text || co.confkey::text || ' ' || co.confupdtype::text || co.confdeltype::text
           when 'u' then co.conkey::text
           else pg_get_constraintdef(co.oid)
         end as signature,
         pg_get_constraintdef(co.oid) as definition,
         coalesce((select array_agg(x order by x)::text from unnest(co.conkey) x), '') as colset,
         case when co.contype = 'f' then pn.nspname || '.' || pc.relname else '' end as parent,
         case when co.contype = 'f' then co.confupdtype::text || co.confdeltype::text else '' end as actions
  from pg_constraint co
  left join pg_class pc on pc.oid = co.confrelid
  left join pg_namespace pn on pn.oid = pc.relnamespace
  join pg_class c on c.oid = co.conrelid
  join pg_namespace n on n.oid = c.relnamespace
  where co.contype in ('f', 'u', 'c')
    and n.nspname not in ('pg_catalog', 'information_schema', 'drizzle')
    and c.relispartition = false
  order by n.nspname, c.relname, co.conname
`;
