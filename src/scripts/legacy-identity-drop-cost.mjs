#!/usr/bin/env node
/**
 * What it would actually cost to drop the legacy identity tables.
 *
 * Phase 2, ticket 08. The ticket tracks progress by counting *readers* -- files
 * that import `leads`, `clients`, `contacts` or `crm_organizations` -- and that
 * number went 71 -> 23 over the phase, which reads like the drop is nearly due.
 *
 * It is not, and reader count is the wrong measure. A reader is a file to edit.
 * A **foreign key** is a column in somebody else's table that has to be
 * migrated, backfilled and re-pointed before the referenced table can go at all,
 * and those live in modules that have never heard of this phase: `invoices` and
 * `purchase_bills` in accounting, `inv_sales_orders` in inventory,
 * `support_tickets`, `build.tickets`, `timesheet_rates`.
 *
 * So this counts the thing that actually gates the drop. Run it before touching
 * the ticket, because the answer moves as other workstreams migrate their own
 * tables, and a number measured in July is not evidence in September.
 *
 *   node --env-file=.env src/scripts/legacy-identity-drop-cost.mjs
 */
import postgres from "postgres";

const LEGACY = ["leads", "clients", "contacts", "crm_organizations"];

const sql = postgres(process.env.DATABASE_URL, { max: 1 });

const rows = await sql`
  SELECT c.confrelid::regclass::text AS referenced,
         c.conrelid::regclass::text  AS referencing,
         c.conname                   AS constraint_name
  FROM pg_constraint c
  WHERE c.contype = 'f'
    AND c.confrelid::regclass::text = ANY(${LEGACY})
  ORDER BY 1, 2, 3`;

const byTable = new Map();
for (const row of rows) {
  if (!byTable.has(row.referenced)) byTable.set(row.referenced, new Set());
  byTable.get(row.referenced).add(row.referencing);
}

/**
 * Self-references and the map tables go with the table itself.
 *
 * `contacts.lead_id` is dropped by dropping `contacts`, and `lead_party_map` is
 * the seam -- neither is somebody else's column to migrate. Counting them as
 * blockers overstates the cost in the same direction the reader count
 * understates it.
 */
const goesWithIt = (referenced, referencing) =>
  LEGACY.includes(referencing) || referencing.endsWith("_party_map");

let blocking = 0;
for (const [referenced, referencing] of byTable) {
  const outside = [...referencing].filter((t) => !goesWithIt(referenced, t)).sort();
  blocking += outside.length;
  console.log(`\n${referenced} — ${outside.length} table(s) outside the seam must migrate first`);
  for (const table of outside) console.log(`    ${table}`);
}

/**
 * How much of the expand has landed.
 *
 * A blocking column is *ready* once a party column sits beside it and is
 * populated -- at that point migrating its readers is the only thing between it
 * and the contract. Reported separately from the blocker count because the two
 * move independently: the foreign keys do not go away until the contract
 * migration, so a bare blocker count shows no progress at all while the
 * expensive half is being done.
 */
const ready = await sql`
  SELECT c.table_name, c.column_name,
         (SELECT count(*)::int FROM information_schema.columns p
           WHERE p.table_schema = c.table_schema AND p.table_name = c.table_name
             AND p.column_name IN ('client_party_id','vendor_party_id','customer_party_id','party_id'))
           AS has_party
    FROM information_schema.columns c
   WHERE c.column_name IN ('client_id','vendor_id','customer_id')
     AND c.table_name = ANY(${[...new Set(rows.map((r) => r.referencing.replace(/^\w+\./, "")))]})
   ORDER BY 1`;

const withParty = ready.filter((r) => r.has_party > 0).length;
console.log(
  `\nExpand: ${withParty} of ${ready.length} blocking columns now carry a party beside them.`,
);

console.log(`\nTotal foreign keys: ${rows.length}`);
console.log(`Tables that must migrate before any drop: ${blocking}`);
console.log(
  blocking === 0
    ? "\nNothing outside the seam still points here. The drop is a migration, not a programme."
    : "\nThe drop is blocked on those tables, not on the CRM's own readers.",
);

await sql.end();
