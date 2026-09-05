import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * PEND-DB — the invariants that keep `pnpm db:bootstrap` reaching head.
 *
 * This schema could not be rebuilt from empty. The first failure was `0352`, and
 * behind it were ninety more; when they were finally counted, the cause of most
 * of them was a single clerical fact: **fifteen `.sql` files existed in
 * `migrations/` and were absent from `_journal.json`**, so nothing ever ran
 * them, and everything that depended on their columns and tables failed on every
 * cold build. Two of the fifteen were missing on purpose. Thirteen were missing
 * by accident and nobody could tell the difference, because there was nowhere
 * that said which was which.
 *
 * That is what these tests are: the place that says which is which, and the
 * guards against the same thing happening again.
 */

const MIGRATIONS = resolve(process.cwd(), "migrations");

interface Journal {
  entries: Array<{ idx: number; tag: string }>;
}

const journal = JSON.parse(
  readFileSync(join(MIGRATIONS, "meta", "_journal.json"), "utf8"),
) as Journal;

const sqlFiles = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql"))
  .map((f) => f.slice(0, -4));

const read = (tag: string) => readFileSync(join(MIGRATIONS, `${tag}.sql`), "utf8");

/**
 * A file in `migrations/` that is deliberately not journalled, and the reason.
 *
 * A name and a sentence, never a bare list — the same argument
 * `inventory-schema-reachability.spec.ts` makes for its exemptions. An
 * un-journalled migration is invisible: it never runs, nothing reports it, and
 * the failure surfaces somewhere else entirely as a missing column.
 */
const NOT_JOURNALLED: ReadonlyArray<{ tag: string; reason: string }> = [];

describe("PEND-DB — every migration is journalled, or says why not", () => {
  it("finds the migrations at all, so a broken walk cannot pass silently", () => {
    expect(sqlFiles.length).toBeGreaterThan(300);
    expect(journal.entries.length).toBeGreaterThan(300);
  });

  it("runs every .sql file in migrations/, or names it as deliberately excluded", () => {
    const journalled = new Set(journal.entries.map((e) => e.tag));
    const excluded = new Set(NOT_JOURNALLED.map((e) => e.tag));
    const orphans = sqlFiles.filter((f) => !journalled.has(f) && !excluded.has(f));
    // Fifteen of these is how the cold build came to be ninety-one failures.
    expect(orphans).toEqual([]);
  });

  it("does not journal a migration that has no file", () => {
    const files = new Set(sqlFiles);
    expect(journal.entries.map((e) => e.tag).filter((t) => !files.has(t))).toEqual([]);
  });

  it("gives every exclusion a file and a reason somebody can read", () => {
    for (const { tag, reason } of NOT_JOURNALLED) {
      expect(sqlFiles).toContain(tag);
      expect(reason.length).toBeGreaterThan(80);
      // The file has to agree that it is excluded, so the two cannot drift.
      expect(read(tag)).toMatch(/NOT JOURNALL?ED/i);
    }
  });

  it("backfills hr_people's identity before the migration that drops it", () => {
    // 0486 phase C copies three columns into organization_people; 0488 drops
    // eleven. The eight in between had no copy anywhere, so on a database with
    // rows 0488 was permanent loss of employee personal data. 0487a carries
    // them and aborts on anything it cannot place — which only protects
    // anything if it runs FIRST. Ordering is the whole guarantee, so it is
    // asserted here rather than trusted to whoever next edits the journal.
    const order = journal.entries.map((e) => e.tag);
    const backfill = order.indexOf("0487a_hr_people_backfill_identity_to_org_person");
    const drop = order.indexOf("0488_hr_people_drop_identity_cols");
    expect(backfill).toBeGreaterThanOrEqual(0);
    expect(drop).toBeGreaterThanOrEqual(0);
    expect(backfill).toBeLessThan(drop);
  });

  it("keeps the backfill able to fail, so a bad copy cannot pass silently", () => {
    // A backfill that swallows its own shortfall is worse than none: 0488 would
    // then drop columns nobody proved were copied.
    const sql = read("0487a_hr_people_backfill_identity_to_org_person");
    expect(sql).toMatch(/RAISE EXCEPTION/);
    for (const column of [
      "personal_email",
      "phone",
      "date_of_birth",
      "gender",
      "nationality",
      "address",
      "emergency_contact",
      "avatar_url",
    ])
      expect(sql).toContain(column);
  });

  /**
   * A forward-repair migration — `NNNNb_…` beside `NNNN_…` — exists to complete
   * work its base could not finish, and the two are not guaranteed to run in
   * numeric order: `db-bootstrap.mjs` and `apply-chain-cold.mjs` both walk
   * `journal.entries` in ARRAY order, and main journals its repairs mid-array.
   *
   * `0678b_feedback_cycle_responses_rls_complete` therefore ran at array position
   * 400 and `0678_rls_fix_feedback_cycle_responses` at 457. Both add
   * `fk_feedback_cycle_responses_org`. 0678b guarded it; 0678 did not — so the
   * base aborted on its own repair's work and `db:bootstrap` stopped at 457/630.
   *
   * The idx-contiguity test below cannot see this, because contiguous idx and safe
   * order are different properties. This one asks for something stronger than an
   * order: that a constraint both halves of a repair pair create is safe in EITHER
   * order. That holds however the journal is later merged or renumbered.
   */
  it("guards a constraint that both halves of a repair pair add", () => {
    const ADD_CONSTRAINT = /ADD\s+CONSTRAINT\s+"?([A-Za-z0-9_]+)"?/gi;
    const tags = journal.entries.map((e) => e.tag);
    const addsIn = (tag: string) => {
      const sql = read(tag);
      return { sql, names: new Set([...sql.matchAll(ADD_CONSTRAINT)].map((m) => m[1])) };
    };

    const pairs = tags.flatMap((repair) => {
      const n = /^(\d+)b_/.exec(repair)?.[1];
      if (!n) return [];
      const base = tags.find((t) => new RegExp(`^${n}_`).test(t));
      return base ? [[base, repair] as const] : [];
    });

    // Guard on the guard: if the pairing regex stops matching, this must not pass as zero.
    expect(pairs.length).toBeGreaterThanOrEqual(5);

    const unguarded: string[] = [];
    for (const [base, repair] of pairs) {
      const b = addsIn(base);
      const r = addsIn(repair);
      for (const name of [...b.names].filter((n) => r.names.has(n))) {
        for (const [tag, { sql }] of [[base, b], [repair, r]] as const) {
          // The house idiom is a DO block testing pg_constraint for this conname.
          if (!sql.includes(`conname = '${name}'`)) {
            unguarded.push(`${tag} adds ${name} unguarded, and its pair adds it too`);
          }
        }
      }
    }

    expect(unguarded).toEqual([]);
  });

  it("keeps idx contiguous, because idx is the order things run in", () => {
    expect(journal.entries.map((e) => e.idx)).toEqual(
      journal.entries.map((_, i) => i),
    );
  });
});

describe("PEND-DB — a migration may not name a column nobody declares", () => {
  /**
   * `0575`–`0579` author the composite tenant foreign keys. Their own headers
   * say that 635 of the 799 on the shared branch "were applied by hand and exist
   * in no migration file" — and the columns those keys name are part of the same
   * hand-applied drift. Forty of the 714 statements reference a column that no
   * `pgTable` in `src/db/schema/` declares, so on a database built from
   * migrations the column is simply not there.
   *
   * Each ADD is therefore guarded on its columns existing, which is the faithful
   * completion of the guard those files already carry for tables and
   * constraints. A skip is silent, though, and `0576`'s own header says a guard
   * whose failure mode is silence is worse than no guard — so this test is where
   * the skipping is said out loud. It fails if any of the five grows an
   * unguarded ADD.
   */
  const FK_FILES = [
    "0575_inventory_composite_tenant_fks",
    "0576_tenant_fks_public_a",
    "0577_tenant_fks_public_b",
    "0578_tenant_fks_public_c",
    "0579_tenant_fks_build_schemas",
  ];

  const ADD = /ALTER TABLE\s+((?:"[A-Za-z0-9_]+"\.)?"[A-Za-z0-9_]+")\s+ADD CONSTRAINT\s+"([A-Za-z0-9_]+)"\s+FOREIGN KEY/g;
  const ADD_ONE = /ALTER TABLE\s+((?:"[A-Za-z0-9_]+"\.)?"[A-Za-z0-9_]+")\s+ADD CONSTRAINT\s+"([A-Za-z0-9_]+)"\s+FOREIGN KEY/;

  it("finds the tenant-FK migrations at all", () => {
    for (const f of FK_FILES) expect(read(f).length).toBeGreaterThan(1000);
  });

  it("guards every ADD CONSTRAINT on the columns it names", () => {
    const unguarded: string[] = [];
    for (const f of FK_FILES) {
      const src = read(f);
      // Each ADD lives in its own `DO $$ ... END $$;` block.
      for (const block of src.split("--> statement-breakpoint")) {
        // A real statement, not the header's prose about one.
        const named = ADD_ONE.exec(block);
        if (!named) continue;
        if (!block.includes("column_name = ANY")) unguarded.push(`${f}:${named[2]}`);
      }
    }
    expect(unguarded).toEqual([]);
  });

  it("counts the statements, so a file cannot be quietly emptied", () => {
    const total = FK_FILES.reduce(
      (n, f) => n + [...read(f).matchAll(ADD)].length,
      0,
    );
    expect(total).toBe(714);
  });
});

describe("PEND-DB — the two irreversible steps stay opt-in", () => {
  /**
   * `0278` drops `leads`, `clients`, `contacts` and `crm_organizations`. Its
   * header says nothing reads them. That is true of three of the four and false
   * of `clients`, which thirteen accounting and finance services still query
   * directly — the identity cutover finished its CRM half and never reached the
   * ledger. It could never run before, because `0263` was one of the fifteen
   * orphans, so an accident of the bookkeeping was the only thing standing
   * between that file and a broken ledger. It is now explicit instead.
   */
  it("keeps the legacy identity drop behind an explicit session opt-in", () => {
    const src = read("0278_drop_legacy_identity_tables");
    expect(src).toContain("app.allow_legacy_identity_drop");
    // Every destructive block, not just the first.
    const dropBlocks = src.split("DO $$").filter((b) => /DROP TABLE|DROP CONSTRAINT/.test(b));
    expect(dropBlocks.length).toBeGreaterThan(0);
    for (const b of dropBlocks) expect(b).toContain("app.allow_legacy_identity_drop");
  });

  it("still refuses to run while any non-party module reads the legacy tables", () => {
    // The condition that makes the opt-in the right shape rather than a
    // formality. When this list empties, the drop becomes a decision somebody
    // can actually take.
    const readers = liveReadersOfLegacyTables();
    expect(readers.length).toBeGreaterThan(0);
    expect(read("0278_drop_legacy_identity_tables")).toContain("thirteen");
  });
});

/** Non-party modules that still query the legacy CRM identity tables. */
function liveReadersOfLegacyTables(): string[] {
  const roots = [resolve(process.cwd(), "src", "modules")];
  const found: string[] = [];
  const query = /\b(?:from|innerJoin|leftJoin|insert|update|delete)\(\s*clients\b|\.clients\.find(?:Many|First)/;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        if (entry === "__tests__" || entry === "party") continue;
        walk(path);
      } else if (path.endsWith(".ts") && !path.endsWith(".spec.ts")) {
        if (query.test(readFileSync(path, "utf8"))) found.push(path);
      }
    }
  };
  for (const r of roots) walk(r);
  return found;
}
