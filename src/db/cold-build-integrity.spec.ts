import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

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
    "0575a_inventory_composite_tenant_fks",
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

  it("names every reader of the legacy tables, because each one blocks the drop", () => {
    // This used to assert the opposite and then assert zero. Thirteen accounting
    // and finance services once read `clients`, which is what made the opt-in
    // the right shape; the gl_* rewrite deleted them and the CRM lane moved the
    // rest onto parties. Zero stopped being a safe claim the moment main's lanes
    // merged back in: a module that still reads `leads`/`clients`/`contacts`/
    // `crm_organizations` is exactly what an owner must know about before
    // running 0278 under `app.allow_legacy_identity_drop`, and a bare
    // `toEqual([])` tells them nothing but "the list grew".
    //
    // So the readers are named. A reader that is not listed fails here and must
    // either move onto the Party or be added below with the reason it still
    // reads — it is then a recorded blocker of the drop rather than a surprise
    // inside it. 0278's header still says "thirteen", and is left byte-identical
    // because its content hash is its identity.
    const unknownModules = liveReadersOfLegacyTables().filter(
      (path) => !(path in KNOWN_LEGACY_READERS),
    );
    expect(unknownModules).toEqual([]);

    const unknownSchema = schemaFilesReferencingLegacyTables().filter(
      (path) => !(path in KNOWN_LEGACY_SCHEMA_REFERENCES),
    );
    expect(unknownSchema).toEqual([]);
  });
});

/**
 * Non-party modules known to read a legacy identity table, and why. Each entry
 * blocks the opt-in 0278 drop until it moves onto the Party. Empty at the merge
 * of main into the inventory integration head: main's one remaining reader,
 * `finance/ar/statements.service.ts`, went with the gl_* rewrite.
 */
const KNOWN_LEGACY_READERS: Readonly<Record<string, string>> = {};

/**
 * Schema files outside `crm/` and `party/` that hold a Drizzle reference to a
 * legacy identity table. A foreign key into `clients` is a blocker in the same
 * way a reader is: 0278 cannot drop a table another table still points at.
 */
const KNOWN_LEGACY_SCHEMA_REFERENCES: Readonly<Record<string, string>> = {
  "src/db/schema/build/ticket-core.ts":
    "Build's ticket core (fenced, owned by the Build lane) keys a ticket's client on `clients.id`.",
  "src/db/schema/support/agent-routing.ts":
    "Support agent routing names `clients` for its customer reference.",
};

const LEGACY_TABLE_SYMBOL = String.raw`(?:clients|contacts|leads|crmOrganizations)`;

/** Non-party modules that still query the legacy CRM identity tables. */
function liveReadersOfLegacyTables(): string[] {
  const roots = [resolve(process.cwd(), "src", "modules")];
  const found: string[] = [];
  const query = new RegExp(
    String.raw`\b(?:from|innerJoin|leftJoin|rightJoin|insert|update|delete)\(\s*${LEGACY_TABLE_SYMBOL}\b|\.${LEGACY_TABLE_SYMBOL}\.find(?:Many|First)`,
  );
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        if (entry === "__tests__" || entry === "party") continue;
        walk(path);
      } else if (path.endsWith(".ts") && !path.endsWith(".spec.ts")) {
        if (query.test(readFileSync(path, "utf8"))) found.push(relative(process.cwd(), path));
      }
    }
  };
  for (const r of roots) walk(r);
  return found.sort();
}

/** Schema files outside crm/ and party/ that import a legacy identity table. */
function schemaFilesReferencingLegacyTables(): string[] {
  const root = resolve(process.cwd(), "src", "db", "schema");
  const found: string[] = [];
  const reference = new RegExp(
    String.raw`import\s*\{[^}]*\b${LEGACY_TABLE_SYMBOL}\b[^}]*\}\s*from\s*["'][^"']*crm/(?:contacts|leads)["']`,
  );
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        if (entry === "crm" || entry === "party") continue;
        walk(path);
      } else if (path.endsWith(".ts") && !path.endsWith(".spec.ts")) {
        if (reference.test(readFileSync(path, "utf8"))) found.push(relative(process.cwd(), path));
      }
    }
  };
  walk(root);
  return found.sort();
}

describe("PEND-DB — 0320's org_id walk cannot depend on heap order", () => {
  /**
   * `0320_recon_phase_a_orgid` adds `org_id` to every public table holding a NOT-NULL
   * single-column FK to an org-bearing parent. It used to do that in ONE unordered pass
   * over `pg_class`, and a table only qualified when its parent ALREADY carried the
   * column — so a child visited before its parent failed the test and was never revisited.
   * The resulting schema was a function of heap order.
   *
   * That is measured, not feared. Two fresh databases built from this journal at this
   * commit ended 0320 with **744** and **743** `org_id`-bearing tables; the one that
   * differed was `workflow_actions`. `workflow_triggers` and `workflow_variables` — two
   * levels down from `workflows` — were missed by BOTH, because one pass cannot close a
   * chain. The deterministic file reaches 746 on every build.
   *
   * Tenant isolation is keyed on `org_id`, so the failure mode is not a crash: a table
   * that silently misses the column gets no `trg_set_org_id` and no tenant policy. Only
   * one of the two possible schemas was ever tested.
   *
   * Two properties fix it and BOTH are load-bearing, so both are asserted here — a total
   * order on every candidate query, and iteration to a fixed point. Ordering alone is not
   * enough (a child sorted before its parent is still missed); a fixed point alone is not
   * enough (which parent a two-parent table binds to would still be planner luck).
   */
  const TAG = "0320_recon_phase_a_orgid";
  const src = read(TAG);
  const block = src.slice(src.indexOf("DO $$"));

  it("finds 0320's catalog walk at all, so a gutted file cannot pass vacuously", () => {
    expect(src.length).toBeGreaterThan(3000);
    expect(block.length).toBeGreaterThan(1500);
    expect(block).toContain("FROM pg_class c");
    expect(block).toContain("trg_set_org_id");
    expect(block).toContain("ADD COLUMN IF NOT EXISTS org_id");
  });

  /**
   * Paren depth for every character of the block, so "the query this LIMIT belongs to"
   * means the same scope rather than the nearest `SELECT` in the text — an inner LATERAL
   * that happens to be ordered otherwise vouches for an unordered outer pick, which is
   * exactly the false pass this check was written to avoid.
   */
  const depths: number[] = [];
  {
    let d = 0;
    for (let i = 0; i < block.length; i++) {
      if (block[i] === "(") {
        depths[i] = d;
        d++;
      } else if (block[i] === ")") {
        d--;
        depths[i] = d;
      } else depths[i] = d;
    }
  }
  const atDepth = (from: number, to: number, depth: number): string =>
    [...block.slice(from, to)].filter((_, k) => (depths[from + k] ?? -1) === depth).join("");

  it("orders every row-picking query, so no candidate is chosen by planner luck", () => {
    const limits = [...block.matchAll(/\bLIMIT\s+1\b/gi)].map((m) => m.index ?? 0);
    // Anti-vacuity: the parent-FK pick, the parent's org-column pick and the PK pick.
    expect(limits.length).toBeGreaterThanOrEqual(3);

    const unanchored: string[] = [];
    const unordered: string[] = [];
    for (const at of limits) {
      const depth = depths[at] ?? 0;
      let select = -1;
      for (let i = at - 6; i >= 0; i--)
        if (block.startsWith("SELECT", i) && (depths[i] ?? -1) === depth) {
          select = i;
          break;
        }
      const excerpt = block.slice(Math.max(0, at - 110), at + 8).trim();
      if (select < 0) unanchored.push(excerpt);
      else if (!/ORDER BY/i.test(atDepth(select, at, depth))) unordered.push(excerpt);
    }
    // Every LIMIT must be attributable to a query, or the check below means nothing.
    expect(unanchored).toEqual([]);
    expect(unordered).toEqual([]);
  });

  it("breaks the parent-FK tie on something unique, because an ORDER BY can be partial", () => {
    // Present-and-partial is the case the scan above cannot see: a table with two
    // NOT-NULL single-column FKs to two org-bearing parents ties on the CASE, and the
    // planner then picks. `con.conname` is unique per table, so ending on it makes the
    // order total by construction and pins which parent the trigger derives org_id from.
    const pick = block.indexOf("FROM pg_constraint con");
    expect(pick).toBeGreaterThan(0);
    const depth = depths[pick] ?? 0;
    let limit = -1;
    for (let i = pick; i < block.length; i++)
      if (block.startsWith("LIMIT 1", i) && (depths[i] ?? -1) === depth) {
        limit = i;
        break;
      }
    // Anti-vacuity: without the pick's own LIMIT there is nothing to be ordered.
    expect(limit).toBeGreaterThan(pick);
    const order = atDepth(pick, limit, depth).match(/ORDER BY[\s\S]*/);
    expect(order).not.toBeNull();
    expect(order?.[0] ?? "").toContain("con.conname");
  });

  it("iterates its work list in a declared order rather than heap order", () => {
    const headers = [...block.matchAll(/FOR\s+\w+\s+IN([\s\S]*?)\bLOOP\b/g)].map(
      (m) => m[1] ?? "",
    );
    expect(headers.length).toBeGreaterThanOrEqual(1);
    for (const header of headers) expect(header).toMatch(/ORDER BY/i);
    // The whole pass is materialised by one ordered query before any DDL runs, so the
    // work list and the parent bound to each table are fixed under a single snapshot.
    expect(block).toMatch(/jsonb_agg\(\s*to_jsonb\(t\)\s+ORDER BY/i);
    expect(block).toMatch(/ORDER BY c\.relname/);
  });

  it("repeats until a pass adds nothing, so a child is reached after its parent", () => {
    expect(block).toMatch(/EXIT WHEN added = 0/);
    expect(block).toMatch(/added\s*:=\s*added\s*\+\s*1/);
    // And it must refuse rather than silently truncate the closure if it never converges.
    expect(block).toMatch(/RAISE EXCEPTION[\s\S]{0,140}converge/i);
  });

  it("stays re-runnable, because editing this file changed its content hash", () => {
    // `db-bootstrap.mjs` keys applied migrations on sha256(content), so this file now
    // re-runs on every database where the old text had already applied. Verified against
    // a populated database: backfill, SET NOT NULL and both constraints are no-ops twice.
    expect(block).toContain("ADD COLUMN IF NOT EXISTS org_id");
    expect(block).toContain("DROP TRIGGER IF EXISTS trg_set_org_id");
    const adds = [...block.matchAll(/ADD CONSTRAINT %I/g)];
    // The only two statements that cannot simply be repeated. Both sit inside a guard.
    expect(adds.length).toBe(2);
    for (const m of adds) {
      const at = m.index ?? 0;
      const guard = block.lastIndexOf("IF NOT EXISTS (SELECT 1 FROM pg_constraint", at);
      expect(guard).toBeGreaterThanOrEqual(0);
      expect(block.slice(guard, at)).not.toContain("END IF;");
    }
  });
});
