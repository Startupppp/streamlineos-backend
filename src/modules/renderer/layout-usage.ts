import { sql } from "drizzle-orm";
import { type Db } from "../../db/drizzle.module";
import type { LayoutUsage } from "./record-layouts.service";

/**
 * How often each field of a record type actually carries a value.
 *
 * This exists so the product can *propose* an arrangement — "nobody fills in
 * Website; hide it" — rather than leaving a tenant to work it out from a form
 * they already find too long.
 *
 * Counted on the server because that is where the records are. A proposal built
 * from the fifty rows a list happened to load would be a proposal about page one.
 *
 * **Deliberately partial.** There are thirty-nine registered layouts and this
 * knows two of them. A backend map of all thirty-nine would be a second copy of
 * the frontend registry, drifting from it silently, and a wrong proposal is
 * worse than none: it tells an administrator to hide a field their team uses.
 * An unknown key returns an empty proposal, which the caller renders as "no
 * suggestion" — honest, and the same thing it renders before the fetch lands.
 */

/** Bounded so a tenant with a million parties does not scan them to draw a form. */
const SAMPLE_CAP = 5000;

/**
 * Nullable columns a tenant may or may not populate.
 *
 * Only nullable ones: a NOT NULL column is filled by definition, so counting it
 * would report 100% and propose nothing.
 */
const PARTY_OPTIONAL_COLUMNS = [
  "legal_name",
  "display_name",
  "tax_number",
  "website",
  "email",
  "phone",
  "notes",
  "job_title",
  "department",
] as const;

const EMPTY: LayoutUsage = { sample: 0, filled: {} };

async function partyUsage(db: Db, organizationId: string): Promise<LayoutUsage> {
  const counts = PARTY_OPTIONAL_COLUMNS.map(
    (column) =>
      sql`count(*) filter (where ${sql.raw(`"${column}"`)} is not null and ${sql.raw(`"${column}"`)} <> '') as ${sql.raw(`"${column}"`)}`,
  );

  const rows = await db.execute(sql`
    select count(*) as sample, ${sql.join(counts, sql`, `)}
    from (
      select * from "business_parties"
      where "organization_id" = ${organizationId} and "deleted_at" is null
      limit ${SAMPLE_CAP}
    ) sampled
  `);

  const row = (rows as unknown as Record<string, unknown>[])[0];
  if (!row) return EMPTY;

  const filled: Record<string, number> = {};
  for (const column of PARTY_OPTIONAL_COLUMNS) {
    // Column names are snake_case in the database and camelCase in the layout
    // description; the caller addresses fields by the description's names.
    const field = column.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
    filled[field] = Number(row[column] ?? 0);
  }

  return { sample: Number(row.sample ?? 0), filled };
}

/**
 * A subject's fields are entirely tenant-declared, so every one is worth
 * counting — there are no platform columns to exclude.
 */
async function subjectUsage(
  db: Db,
  organizationId: string,
  typeKey: string,
): Promise<LayoutUsage> {
  const rows = await db.execute(sql`
    with sampled as (
      select s."custom_fields" as custom_fields
      from "subjects" s
      join "subject_types" t
        on t."subject_type_id" = s."subject_type_id"
       and t."organization_id" = s."organization_id"
      where s."organization_id" = ${organizationId}
        and s."deleted_at" is null
        and t."key" = ${typeKey}
      limit ${SAMPLE_CAP}
    ),
    per_field as (
      select entry.key as field, count(*) as filled
      from sampled, jsonb_each(coalesce(sampled.custom_fields, '{}'::jsonb)) as entry
      where jsonb_typeof(entry.value) <> 'null'
        and (jsonb_typeof(entry.value) <> 'string' or entry.value <> '""'::jsonb)
      group by entry.key
    )
    select
      (select count(*) from sampled) as sample,
      (
        select coalesce(jsonb_object_agg(field, filled), '{}'::jsonb)
        from per_field
      ) as filled
  `);

  const row = (rows as unknown as Record<string, unknown>[])[0];
  if (!row) return EMPTY;

  const raw = row.filled;
  const filled: Record<string, number> = {};
  if (raw && typeof raw === "object")
    for (const [key, value] of Object.entries(raw as Record<string, unknown>))
      filled[key] = Number(value ?? 0);

  return { sample: Number(row.sample ?? 0), filled };
}

export async function layoutUsage(
  db: Db,
  organizationId: string,
  layoutKey: string,
): Promise<LayoutUsage> {
  if (layoutKey === "party") return partyUsage(db, organizationId);

  const subject = /^subject:([a-z][a-z0-9-]*)$/.exec(layoutKey);
  if (subject?.[1]) return subjectUsage(db, organizationId, subject[1]);

  return EMPTY;
}
