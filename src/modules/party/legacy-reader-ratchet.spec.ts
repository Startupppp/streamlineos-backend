import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";

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
   * from the schema. Delete lines as each migrate batch lands; never add one.
   */
  const KNOWN_READERS = [
  // The seam itself, plus what writes through it and what checks it. Not call
  // sites to migrate -- they are what everything else migrates ONTO, and they
  // import the legacy tables for the same reason `party-legacy-seam.ts` always
  // has: something must name the table it is standing in for. When this list
  // reaches only these, ticket 08 can drop the tables and these files with them.
  "src/modules/party/party-divergence.service.ts",
  "src/modules/party/party-legacy-clients.ts",
  "src/modules/party/party-legacy-contacts.ts",
  "src/modules/party/party-legacy-employer.ts",
  "src/modules/party/party-legacy-leads.ts",
  "src/modules/party/party-legacy-mirror.spec.ts",
  "src/modules/party/party-legacy-orgs.ts",
  "src/modules/party/party-legacy-seam.ts",
  "src/modules/party/party-legacy-writer.db.spec.ts",
  "src/modules/party/party-legacy-writer.spec.ts",
  "src/modules/party/party-legacy-writer.ts",
  "src/modules/party/party-mirror-fields.ts",

  // ---------------------------------------------------------------------
  // Revealed by widening the detection, not added by anyone.
  //
  // These read a legacy table through a relational `with:` include or raw SQL,
  // so the symbol-import scan above never saw them. They have been there the
  // whole time. Recording them is the same move ticket 25 made when
  // `crm_organizations` turned out to be the fifth identity table: the list
  // grows because what is *watched* grew, never because a rule was relaxed.
  //
  // Several are live, in modules that have never heard of this phase, which is
  // exactly why nobody counted them. Each reads a customer's name off the
  // mirror while the party id sits on the same row -- `deals.party_id` is
  // already written, so most of these are a projection change, not a migration.
  // They are the real remaining cost of ticket 08's DROP.
  "src/modules/inventory/sales-orders/so-core.service.ts",
  "src/modules/invoices/invoices.service.ts",
  // Two tests: a mocked db shaped like the old query, and a seam test that
  // names the tables it backfills. The latter counts rows in each legacy table
  // to prove none lacks a Party, which is the one claim that cannot be made
  // from the Party side. Both go when the tables do.
  "src/modules/ai/core/crm-copilot.service.phase2.spec.ts",
  "src/modules/party/party-legacy-backfill.db.spec.ts",
  ];

  /** Import of the Drizzle table symbol, which is how a read actually begins. */
  const LEGACY_IMPORT = new RegExp(
    String.raw`import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]*(?:db/schema|schema/crm)[^'"]*)['"]`,
    "gs",
  );
  const LEGACY_TABLES = new Set(["leads", "clients", "contacts", "crmOrganizations"]);

  /*
    A symbol import is how a read *usually* begins, and for a long time this file
    assumed it was the only way. It is not, and the two vectors it missed are the
    ones a migration is least likely to notice.

    A relational include -- `db.query.deals.findMany({ with: { client: true } })`
    -- resolves through a relation declared in the schema, so the call site names
    neither the table nor its symbol and reads the whole legacy row anyway. Raw
    SQL does the same thing more plainly. Both were invisible here, and both are
    live: the census that found them is in the phase 2 audit, and it moved the
    non-seam reader count from 11 to 18.

    These are matched textually, which is coarse -- `FROM leads` inside a string
    that is not SQL would match. Coarse in this direction is the right error:
    a false positive costs an argument in review, a false negative costs a table
    that cannot be dropped and nobody knows why.
  */
  const LEGACY_RELATIONS = new Set(["client", "lead", "contact", "organization"]);
  const RELATIONAL_INCLUDE = new RegExp(
    String.raw`\bwith\s*:\s*\{[^}]*\b(${[...LEGACY_RELATIONS].join("|")})\s*:`,
    "gs",
  );
  const LEGACY_SQL_TABLES = ["leads", "clients", "contacts", "crm_organizations"];
  const RAW_SQL_READ = new RegExp(
    String.raw`\b(?:FROM|JOIN)\s+"?(${LEGACY_SQL_TABLES.join("|")})"?\b`,
    "gis",
  );
  const DB_QUERY_ACCESS = new RegExp(
    String.raw`\bdb\.query\.(leads|clients|contacts|crmOrganizations)\b`,
    "gs",
  );

  /*
    Comments are stripped first, and this is not a nicety.

    Half of this phase's work is files that describe the read they removed --
    `dashboard-crm.service.ts` and `plan-limits.service.ts` both carry a comment
    naming the table they no longer touch. Matching prose would report a migrated
    file as a reader, and a debt register that counts finished work never reaches
    zero. `backfill-slugs-exist.spec.ts` strips for the same reason.
  */
  const executable = (source: string): string =>
    source
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, ""))
      .join("\n");

  /** Every way this file knows of to reach a legacy identity table. */
  function readsLegacy(rawSource: string): boolean {
    const source = executable(rawSource);
    for (const match of source.matchAll(LEGACY_IMPORT))
      for (const raw of match[1]!.split(","))
        if (LEGACY_TABLES.has(raw.split(" as ")[0]!.trim())) return true;
    return (
      RELATIONAL_INCLUDE.test(source) ||
      RAW_SQL_READ.test(source) ||
      DB_QUERY_ACCESS.test(source)
    );
  }

  function readersInTree(): string[] {
    /*
     * Tracked files plus untracked ones git would accept, which is not the same
     * as "tracked". A new call site is a new *file* as often as it is a new line,
     * and a tracked-only scan cannot see one until it is committed -- by which
     * point the ratchet reports it as a regression instead of preventing it. The
     * exclusions keep build artefacts and ignored scratch out.
     */
    const tracked = execSync(
      "git ls-files --cached --others --exclude-standard 'src/**/*.ts'",
      { encoding: "utf8" },
    )
      .split("\n")
      // Tracked-but-deleted paths are still listed, and another session is
      // mid-refactor in this tree, so existence is checked rather than assumed.
      .filter(
        (f) =>
          f &&
          !f.includes("db/schema/") &&
          // The guard names every table and relation it looks for, so it matches
          // itself by construction. Excluding it is not a loophole: nothing in
          // here queries anything.
          !f.endsWith("legacy-reader-ratchet.spec.ts") &&
          existsSync(f),
      );

    return tracked.filter((file) => readsLegacy(readFileSync(file, "utf8")));
  }

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
    const config = readFileSync("eslint.config.mjs", "utf8");

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

    /*
      A subset, not an equality, and the difference is load-bearing.

      Equality held only while a read meant an import. Widening the detection to
      relational includes and raw SQL broke it permanently: `csat.service.ts` and
      four others reach a legacy table without naming its symbol, so they belong
      on the register and need no exemption from an *import* rule. Asserting
      equality would force us to exempt files that never trip the rule, which is
      how an exemption list grows for no reason.

      The direction the docblock above calls the worse one is exactly what this
      still catches: a file exempted here but absent from the register is one
      nobody is stopped from copying.
    */
    const exemptedButUnregistered = exempt.filter((path) => !KNOWN_READERS.includes(path));
    expect(exemptedButUnregistered).toEqual([]);
  });

  it("reports how much of the migration is left", () => {
    const remaining = readersInTree().length;
    // Not an assertion about progress — a number that shows up in the run, so
    // the phase's central task has a visible size rather than a vibe.
    expect(remaining).toBeLessThanOrEqual(KNOWN_READERS.length);
  });
});
