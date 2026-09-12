import fs from "node:fs";
import path from "node:path";

/**
 * Phase 2, ticket 08 — a column referencing `clients` carries a party beside it.
 *
 * The reader register got to five and that turned out not to be what gates the
 * drop. A reader is a file to edit; a **foreign key** is a column in somebody
 * else's table, and `DROP TABLE clients` refuses on the key rather than on the
 * import. Twelve of them live in accounting, inventory, support, build and
 * timesheets — modules that have never heard of this phase.
 *
 * The expand added a party column beside each, and migration 0273 keeps the two
 * in step with a trigger. What neither of those can do is stop a *thirteenth*
 * being added: a new `client_id` written in good faith next month puts the
 * contract migration back where it started, and nothing would say so until it
 * tried to drop the table and found a fresh dependency.
 *
 * So this reads the schema. Every column that references `clients.id` must have
 * a party column declared in the same table.
 */

const SCHEMA = path.join(__dirname);

/** `x: integer("y").references(() => clients.id` */
const REFERENCES_CLIENTS =
  /(\w+):\s*integer\("([a-z_]+)"\)\s*\.references\(\(\)\s*=>\s*clients\.id/g;

/**
 * Tables whose party column the database has but Drizzle does not express.
 *
 * `build.tickets.customer_id` never declared its foreign key in Drizzle either,
 * so there is no `.references(() => clients.id)` here to find. It is listed
 * rather than matched, so it stays visible.
 */
const DECLARED_ELSEWHERE: ReadonlyMap<string, string> = new Map([
  ["build/ticket-core.ts", "customerPartyId — customer_id declares no Drizzle FK"],
  // `deals` was migrated before this convention existed and calls its column
  // `partyId` rather than `clientPartyId`. Renaming it to satisfy a naming rule
  // would rewrite a working column and every reader of it, which is a worse
  // trade than one line here.
  ["crm/deals.ts", "partyId — predates the *PartyId naming"],
]);

function walk(dir: string, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, found);
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith("spec.ts")) found.push(full);
  }
  return found;
}

/** The party column that belongs beside a given legacy column. */
function partyPropFor(prop: string): string {
  return prop.replace(/Id$/, "PartyId");
}


/** Each `pgTable(...)` definition in a file, as its own searchable span. */
function tableBlocks(source: string): { name: string; body: string }[] {
  const starts = [...source.matchAll(/export const (\w+) = pgTable\(/g)];

  return starts.map((match, index) => ({
    name: match[1] as string,
    body: source.slice(
      match.index ?? 0,
      index + 1 < starts.length ? (starts[index + 1]?.index ?? source.length) : source.length,
    ),
  }));
}

describe("every reference to a legacy client carries a party beside it", () => {
  const files = walk(SCHEMA);

  it("declares a party column for each column referencing clients.id", () => {
    const missing: string[] = [];

    for (const file of files) {
      const source = fs.readFileSync(file, "utf8");
      const relative = path.relative(SCHEMA, file).split(path.sep).join("/");
      if (DECLARED_ELSEWHERE.has(relative)) continue;

      /**
       * Searched **within each table**, not across the file.
       *
       * A file-wide search was the first version of this, and it passed while
       * two of the three tables in `crm/contacts.ts` were missing their column
       * -- one `clientPartyId` anywhere satisfied all three. An invariant that
       * can be satisfied by a neighbour is not an invariant.
       */
      for (const table of tableBlocks(source)) {
        for (const match of table.body.matchAll(REFERENCES_CLIENTS)) {
          const [, prop] = match;
          const expected = partyPropFor(prop as string);
          // Named rather than counted, so a failure says which column to pair.
          if (!new RegExp(`\\b${expected}\\s*:`).test(table.body)) {
            missing.push(`${relative}: ${table.name}.${prop as string} has no ${expected}`);
          }
        }
      }
    }

    expect(missing).toEqual([]);
  });

  /**
   * The other direction, so the exemption cannot rot.
   *
   * An entry naming a file that no longer needs it would quietly excuse the next
   * legacy reference added there.
   */
  it("keeps no exemption for a file that no longer needs one", () => {
    // Stale means the file no longer references a legacy client at all -- not
    // that it lacks a particular column name, since the whole reason these are
    // exempt is that their party column is named or declared differently.
    const stale = [...DECLARED_ELSEWHERE.keys()].filter((relative) => {
      const full = path.join(SCHEMA, relative);
      if (!fs.existsSync(full)) return true;
      const source = fs.readFileSync(full, "utf8");
      return !/clients\.id/.test(source) && !/client_id|customer_id/.test(source);
    });

    expect(stale).toEqual([]);
  });
});
