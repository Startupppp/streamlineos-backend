import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Phase 2, ticket 08's own gate — named directly in
 * `migrations/0278_drop_legacy_identity_tables.sql`, which reads: "the day the
 * last [reader] moves, somebody is told." This is that somebody.
 *
 * `0278` refuses to run — `app.allow_legacy_identity_drop` stays `'off'` — for
 * as long as any module outside `party/` still reads `leads`, `clients`,
 * `contacts` or `crm_organizations`. Two narrower ratchets already existed:
 * `party/legacy-identity-collapse.spec.ts` covers the Drizzle schema and the
 * three CRM compatibility modules, and `accounting/parties/
 * accounting-party-only.spec.ts` (ACC-10) covers `modules/accounting` alone —
 * its own comment notes the first ratchet "does not cover accounting". Neither
 * is repo-wide, and the migration's promise is. This is the union, over every
 * module, kept here rather than in either narrower file so ticket 08 has one
 * place to point at.
 *
 * Checks both routes a reader can take: an import of the dropped Drizzle
 * symbols (which the compiler already refuses once `0278` actually drops the
 * tables — but not before, and not for raw SQL, which the compiler cannot see
 * either way) and a raw SQL statement naming the table. `party/` itself is
 * excluded — `party-legacy-*.ts` is the mirror this gate exists to make
 * eventually unnecessary, not a violation of it.
 */

const SRC_ROOT = join(__dirname, "../..");
const MODULES_ROOT = join(SRC_ROOT, "modules");

const LEGACY_SYMBOLS = ["leads", "clients", "contacts", "crmOrganizations"] as const;
const LEGACY_TABLES = ["leads", "clients", "contacts", "crm_organizations"] as const;

/** Everything under `modules/party/` is the mirror itself — excluded, not exempted. */
const EXCLUDED_DIR_PREFIXES = [join(MODULES_ROOT, "party") + "/"];

function tsFilesUnder(path: string): string[] {
  return readdirSync(path).flatMap((entry) => {
    const full = join(path, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) return tsFilesUnder(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

/**
 * Production files only, outside `party/`.
 *
 * A spec's own fixtures are not a read — `accounting-party-only.spec.ts` has
 * to write the string `"SELECT 1 FROM clients"` to prove its scanner isn't
 * vacuous, and a calendar `.db.spec.ts` seeds a row with a raw
 * `insert into leads (...)` for an unrelated tenant-binding test. Neither is
 * this gate's concern: both are gone the moment `0278` actually runs, and
 * until then they exercise fixtures, not a code path that ships.
 */
const CANDIDATE_FILES = tsFilesUnder(MODULES_ROOT).filter((f) => {
  if (f.endsWith(".spec.ts") || f.endsWith(".e2e-spec.ts")) return false;
  return !EXCLUDED_DIR_PREFIXES.some((prefix) => f.startsWith(prefix));
});

/** Comments removed before scanning — see `accounting-party-only.spec.ts` for why. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function importedFromDbSchema(source: string): string[] {
  const imports = source.matchAll(
    /import\s+(?:type\s+)?\{([\s\S]*?)\}\s+from\s+["'](?:\.\.\/)+db\/schema(?:\/index)?["']/g,
  );
  return [...imports].flatMap((match) =>
    match[1]!
      .split(",")
      .map((name) => name.trim().split(/\s+as\s+/i)[0]?.trim())
      .filter((name): name is string => Boolean(name)),
  );
}

describe("no module outside party/ reads a legacy CRM identity table", () => {
  it("scans a real number of files, so a passing result means something", () => {
    // The floor under every assertion below — see the sibling gates for why this exists.
    expect(CANDIDATE_FILES.length).toBeGreaterThan(500);
  });

  it("imports no dropped CRM identity table", () => {
    const violations: string[] = [];
    for (const file of CANDIDATE_FILES) {
      const imported = importedFromDbSchema(readFileSync(file, "utf8")).filter((name) =>
        (LEGACY_SYMBOLS as readonly string[]).includes(name),
      );
      if (imported.length > 0) {
        violations.push(`${relative(SRC_ROOT, file)} imports ${imported.join(", ")}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("names no dropped CRM identity table in raw SQL", () => {
    const violations: string[] = [];
    for (const file of CANDIDATE_FILES) {
      const source = code(readFileSync(file, "utf8"));
      for (const table of LEGACY_TABLES) {
        const inSql = new RegExp(`(FROM|JOIN|INTO|UPDATE)\\s+"?${table}"?\\b`, "i");
        if (inSql.test(source)) {
          violations.push(`${relative(SRC_ROOT, file)} reads ${table}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("distinguishes a SQL read from a comment explaining why not to write one", () => {
    // Anti-vacuity for the stripper — see `accounting-party-only.spec.ts` for the same pair.
    expect(code('const q = "SELECT 1 FROM clients";')).toContain("FROM clients");
    expect(code("// a SELECT ... FROM clients is a read of a copy")).not.toContain("FROM clients");
    expect(code("/* FROM clients is a read of a copy */")).not.toContain("FROM clients");
  });
});
