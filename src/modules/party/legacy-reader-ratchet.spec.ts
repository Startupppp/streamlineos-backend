import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * A ratchet over the identity migration, held while it is in progress.
 *
 * Phase 2 moves every reader of `leads`, `clients`, `contacts` and
 * `crm_organizations` onto Party and then drops those tables. That runs as five independent batches over five
 * modules, so for most of the phase the old tables still exist and still work —
 * which is exactly the window in which somebody adds a fifty-first call site in
 * good faith and nothing complains.
 *
 * Ticket 08 asks for this at contract time. It is here now because a guard that
 * arrives after the migration cannot prevent the migration regressing during it,
 * and "we all know not to use those tables" is the kind of convention that holds
 * right up until the person who knows is on holiday.
 *
 * The list may only shrink. Both directions are enforced:
 *
 *   - a file NOT on the list that imports one of these tables fails the build,
 *     which is the regression this exists to stop;
 *   - a file ON the list that no longer imports one also fails, so the list
 *     cannot rot into a stale allowlist that quietly permits anything.
 *
 * When it reaches zero, `contacts`, `clients`, `leads` and `crm_organizations`
 * have no readers left and ticket 08 can drop them.
 *
 * The list grew ONCE, in ticket 25, when `crm_organizations` turned out to be the
 * fifth identity table and joined the ratchet with the readers it already had.
 * That is a widening of what is watched, not a relaxation of it, and it may not
 * happen again: from here the list only shrinks.
 */
describe("the legacy identity tables gain no new readers", () => {
  /**
   * Every file importing `leads`, `clients`, `contacts` or `crm_organizations`
   * from the schema. Delete lines as each migrate batch lands; add one ONLY when
   * git shows the file was extracted from a listed file (readers moved, not grew).
   */
  const KNOWN_READERS = [
  "src/modules/accounting/core/accounting-aged-receivables.service.ts",
  "src/modules/accounting/core/accounting-payables-query.service.ts",
  "src/modules/accounting/core/accounting-receivables.service.ts",
  "src/modules/accounting/core/accounting-vendor-query.service.ts",
  // Raw SQL in a fixture, not a production read. It seeds a lead in each of two
  // organisations to prove the calendar guard refuses the other tenant's; the
  // service it tests resolves through the seam and reads no legacy table.
  "src/modules/calendar/calendar-linked-crm-tenant-binding.db.spec.ts",
  "src/modules/finance/ap/bills-due-check.service.ts",
  "src/modules/finance/ap/payment-runs.service.ts",
  "src/modules/finance/ap/recurring-bills.service.ts",
  "src/modules/finance/ap/vendor-credits.service.ts",
  "src/modules/finance/ap/vendor-payments-list.service.ts",
  "src/modules/finance/ar/ar-payments.service.ts",
  "src/modules/finance/ar/statements.service.ts",
  "src/modules/finance/banking/matching.service.ts",
  "src/modules/finance/reports/finance-report-export-worker.service.ts",
  "src/modules/finance/reports/insights-finders.service.ts",
  "src/modules/finance/reports/statement-reports.service.ts",
  "src/modules/finance/tax/tax-reports.service.ts",
  "src/modules/party/party-divergence.service.ts",
  // Raw SQL, and the only reader the import scan never could have seen: it
  // counts rows in each legacy table to prove none lacks a Party, which is
  // the one claim that cannot be made from the Party side.
  "src/modules/party/party-legacy-backfill.db.spec.ts",
  "src/modules/party/party-legacy-clients.ts",
  "src/modules/party/party-legacy-contacts.ts",
  "src/modules/party/party-legacy-employer.ts",
  "src/modules/party/party-legacy-leads.ts",
  "src/modules/party/party-legacy-orgs.ts",
  "src/modules/party/party-legacy-mirror.spec.ts",
  "src/modules/party/party-legacy-seam.ts",
  "src/modules/party/party-legacy-writer.db.spec.ts",
  "src/modules/party/party-legacy-writer.spec.ts",
  "src/modules/party/party-legacy-writer.ts",
  "src/modules/party/party-mirror-fields.ts",
  ];

  /** Import of the Drizzle table symbol, which is how a read actually begins. */
  const LEGACY_IMPORT = new RegExp(
    String.raw`import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]*(?:db/schema|schema/crm)[^'"]*)['"]`,
    "gs",
  );
  const LEGACY_TABLES = new Set(["leads", "clients", "contacts", "crmOrganizations"]);

  /** Table names as SQL says them, for the reads no import can reveal. */
  const LEGACY_SQL = /\b(?:from|join|into|update)\s+"?(leads|clients|contacts|crm_organizations)"?\b/i;

  /**
   * A read written as raw SQL rather than as Drizzle.
   *
   * The import scan above is blind to `db.execute(sql\`... FROM leads ...\`)`,
   * because a template string imports nothing. Two such reads survived every
   * migrate batch in this phase for exactly that reason — one opening client
   * accounts from converted leads, one finding duplicate companies — and ticket
   * 08's drop would have taken both out at runtime with the register reading
   * zero and nothing having warned. A guard that says "when this reaches zero the
   * tables can be dropped" has to be able to see every read, or the sentence is
   * false.
   *
   * Comments are stripped first, and that is not tidiness. Every file in this
   * seam explains itself by quoting the SQL it replaced — `party-legacy-leads.ts`,
   * both party readers and `plan-limits.service.ts` all contain the words
   * `FROM leads` in prose. Counting those would put six files on the register
   * that read nothing, and a register with false entries is one people learn to
   * ignore.
   */
  const namesALegacyTableInSql = (source: string): boolean =>
    LEGACY_SQL.test(
      source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 "),
    );

  const SRC_ROOT = resolve(__dirname, "../..");

  /*
   * A filesystem walk, not `git ls-files`. The previous scan shelled out with a
   * single-quoted glob, which cmd.exe does not strip, so `git ls-files` received
   * the pattern literally, matched nothing, and BOTH assertions below passed
   * vacuously -- the ratchet guarded nothing at all on a Windows checkout. A
   * walk sees new files before they are committed, which is the property the
   * `--others` flag was there for.
   */
  function sourceFiles(dir: string, found: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry !== "node_modules") sourceFiles(full, found);
      } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
        found.push(full);
      }
    }
    return found;
  }

  function allSourceFiles(): string[] {
    return sourceFiles(SRC_ROOT)
      .map((full) => `src/${relative(SRC_ROOT, full).split("\\").join("/")}`)
      .filter((file) => !file.includes("db/schema/"));
  }

  function readersInTree(): string[] {
    return allSourceFiles().filter((file) => {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(LEGACY_IMPORT))
        for (const raw of match[1]!.split(","))
          if (LEGACY_TABLES.has(raw.split(" as ")[0]!.trim())) return true;
      return namesALegacyTableInSql(source);
    });
  }

  it("scans enough files that a broken scan cannot pass vacuously", () => {
    // The failure this ratchet actually suffered: the scan returned zero files
    // and every assertion below went green. An empty scan must fail loudly.
    expect(allSourceFiles().length).toBeGreaterThan(2000);
  });

  it("has no reader that is not already known", () => {
    const known = new Set(KNOWN_READERS);
    const added = readersInTree().filter((f) => !known.has(f));

    // A new entry here means a call site was added to a table this phase is
    // removing. Migrate it onto the Party seam (`party-legacy-seam.ts`) rather
    // than adding it to the list above.
    expect(added).toEqual([]);
  });

  it("keeps the list honest as batches land", () => {
    const actual = new Set(readersInTree());
    const departed = KNOWN_READERS.filter((f) => !actual.has(f));

    // These no longer read a legacy table — delete them from KNOWN_READERS. The
    // list is a debt register, and a debt register nobody pays down is a lie.
    expect(departed).toEqual([]);
  });

  /**
   * The lint rule's exemptions and this list are the same list.
   *
   * `eslint.config.mjs` says in a comment that its `ignores` are generated from
   * `KNOWN_READERS` "so the two cannot drift into disagreeing about what is
   * allowed". They drifted the day after it was written: the list was generated
   * from a working tree where another session had deleted `src/modules/finance`,
   * so thirteen real readers were absent from the exemptions and `pnpm lint`
   * would have failed on files this register already accounts for.
   *
   * A comment claiming an invariant is not the invariant. This is.
   *
   * The failure it prevents is worse in the other direction: a file exempted
   * here but absent from the register is one nobody is stopped from copying, and
   * exemption lists only ever get longer by accident.
   */
  it("agrees with the lint rule about which files may still read them", () => {
    // Normalised: the working copy is CRLF on Windows, and anchoring on "\n    "
    // silently found nothing there, which threw rather than compared.
    const config = readFileSync(resolve(SRC_ROOT, "..", "eslint.config.mjs"), "utf8").replace(
      /\r\n/g,
      "\n",
    );

    // Anchored on the rule, not on the shape: three config objects carry an
    // `ignores` array indented exactly like this one, and taking the first is
    // how the regeneration script that produced this list clobbered the block
    // that exempts spec files from the APP_CONFIG rule instead.
    const rule = config.indexOf('"no-restricted-imports"');
    if (rule < 0) throw new Error("eslint.config.mjs no longer restricts the legacy imports");
    const start = config.lastIndexOf("\n    ignores: [\n", rule);
    const end = config.indexOf("\n    ],", start);
    if (start < 0 || end < 0)
      throw new Error("the no-restricted-imports block has no ignores array to compare against");

    const exempt = [...config.slice(start, end).matchAll(/"(src\/[^"]+)"/g)]
      .map((match) => match[1]!)
      .filter((path) => !path.endsWith("/**"));

    expect([...exempt].sort()).toEqual([...KNOWN_READERS].sort());
  });

  it("reports how much of the migration is left", () => {
    const remaining = readersInTree().length;
    // Not an assertion about progress — a number that shows up in the run, so
    // the phase's central task has a visible size rather than a vibe.
    expect(remaining).toBeLessThanOrEqual(KNOWN_READERS.length);
  });
});
