import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * ACC-10. Accounting knows a customer or a vendor as a **Party**, and by no
 * other route.
 *
 * The retarget itself is already done — measured across `modules/accounting`,
 * there are zero references to `clients`, `contacts`, `leads` or
 * `crm_organizations`, in imports or in SQL. What was missing is the thing that
 * keeps it done, and the existing ratchet
 * (`modules/party/legacy-identity-collapse.spec.ts`) does not cover accounting:
 * it checks the Drizzle schema and the three CRM compatibility modules only.
 *
 * It also checks **imports**, which the compiler already blocks — the symbols
 * no longer exist in `db/schema`, so `import { clients }` does not build. The
 * route that would compile is raw SQL, and that is the one nothing was
 * watching.
 *
 * Which matters more than it sounds. `0278_drop_legacy_identity_tables` is one
 * of the destructive migrations that has NOT been applied to the shared
 * development database, so those tables still physically exist there. A
 * `SELECT ... FROM clients` added to an AR report would work perfectly in
 * development and fail on a fresh database — drift that only shows up in the
 * environment where it is most expensive to discover.
 */

const ACCOUNTING_ROOT = join(__dirname, "..");
const REPO_SRC = join(__dirname, "../../..");

const LEGACY_SYMBOLS = ["leads", "clients", "contacts", "crmOrganizations"] as const;
const LEGACY_TABLES = ["leads", "clients", "contacts", "crm_organizations"] as const;

function tsFilesUnder(path: string): string[] {
  return readdirSync(path).flatMap((entry) => {
    const full = join(path, entry);
    if (statSync(full).isDirectory()) return tsFilesUnder(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

/**
 * Comments removed before scanning.
 *
 * Repo-wide, every surviving mention of these table names is prose explaining
 * why a read of one would be a read of a stale copy — seven of them, all in
 * comments. A scanner that could not tell those from code would either fail on
 * good documentation or be quietly weakened until it matched nothing.
 */
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

/**
 * Production files only.
 *
 * A spec's fixtures are not a read — this very file has to write
 * `"SELECT 1 FROM clients"` to prove its own scanner is not vacuous, and
 * without this filter the ratchet's first act is to fail itself.
 */
const ACCOUNTING_FILES = tsFilesUnder(ACCOUNTING_ROOT).filter(
  (f) => !f.endsWith(".spec.ts") && !f.endsWith(".e2e-spec.ts"),
);

describe("accounting knows a counterparty only as a Party", () => {
  it("scans a real number of files, so a passing result means something", () => {
    /*
      The floor under every assertion below. A moved directory or a broken walk
      would make each `toEqual([])` pass over an empty list, which is exactly
      how a guard in this repo went unwatched for months.
    */
    expect(ACCOUNTING_FILES.length).toBeGreaterThan(50);
  });

  it("imports no dropped CRM identity table", () => {
    const violations: string[] = [];
    for (const file of ACCOUNTING_FILES) {
      const imported = importedFromDbSchema(readFileSync(file, "utf8")).filter((name) =>
        (LEGACY_SYMBOLS as readonly string[]).includes(name),
      );
      if (imported.length > 0) {
        violations.push(`${relative(REPO_SRC, file)} imports ${imported.join(", ")}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("names no dropped CRM identity table in raw SQL", () => {
    /*
      The assertion the compiler cannot make. An import of a symbol that no
      longer exists fails to build; a string naming a table that still exists on
      one database does not.
    */
    const violations: string[] = [];
    for (const file of ACCOUNTING_FILES) {
      const source = code(readFileSync(file, "utf8"));
      for (const table of LEGACY_TABLES) {
        const inSql = new RegExp(`(FROM|JOIN|INTO|UPDATE)\\s+"?${table}"?\\b`, "i");
        if (inSql.test(source)) {
          violations.push(`${relative(REPO_SRC, file)} reads ${table}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("distinguishes a SQL read from a comment explaining why not to write one", () => {
    /*
      Anti-vacuity for the stripper, in both directions: if it removed too much
      the previous test would pass over nothing, and if it removed nothing the
      repo's own explanatory comments would fail it.
    */
    expect(code('const q = "SELECT 1 FROM clients";')).toContain("FROM clients");
    expect(code("// a SELECT ... FROM clients is a read of a copy")).not.toContain(
      "FROM clients",
    );
    expect(code("/* FROM clients is a read of a copy */")).not.toContain("FROM clients");
    /* A protocol-relative URL is not a comment. */
    expect(code('const u = "https://example.test/x";')).toContain("https://example.test/x");
  });

  it("reaches CRM through the external-refs pointer and nothing else", () => {
    /*
      The positive half. Absence of the old route is only half the claim; the
      other half is that a real one exists, and that it is a POINTER rather than
      a copy — `gl_parties.external_refs` holds `{system, id}`, so accounting
      still works with CRM absent, which is the invariant the whole seam is for.
    */
    const adapter = readFileSync(
      join(__dirname, "../adapters/posting-command.service.ts"),
      "utf8",
    );
    expect(adapter).toContain("glParties.externalRefs");
    expect(adapter).toContain("resolvePartyByExternalRef");
  });

  /*
    ACC-11. AR and AP resolve a counterparty through the Party and use it for
    identity and display only — nothing else about a customer or a vendor
    reaches these documents.

    Verified structurally rather than by e2e: the acceptance names an e2e that
    creates an invoice and a bill, and this session had no database to run one
    against. What is asserted here is the shape those e2e tests would exercise,
    and it is stated plainly rather than implied, so nobody reads a green suite
    as an end-to-end pass.
  */
  it("resolves an AR document's counterparty through the Party service", () => {
    const ar = readFileSync(join(__dirname, "../ar/ar-documents.service.ts"), "utf8");

    expect(ar).toContain("this.parties.requireForBook(");
    /* Display comes off the resolved Party, never off a CRM row carried along. */
    expect(ar).toContain("party.displayName");
    expect(ar).not.toContain("clientName");
  });

  it("resolves an AP document's vendor the same way", () => {
    const ap = readFileSync(join(__dirname, "../ap/ap-documents.service.ts"), "utf8");
    const lookup = readFileSync(join(__dirname, "../ap/ap.vendor-lookup.ts"), "utf8");

    expect(ap).toContain("requireVendor(");
    /*
      Posting moved out of the service into `ap/lib/ap-document-post.ts`, and
      resolves its vendor the same way on the way to the journal.
    */
    const post = readFileSync(join(__dirname, "../ap/lib/ap-document-post.ts"), "utf8");
    expect(post).toContain("requireVendor(");
    /* Every vendor field AP reads comes off `gl_parties` and nowhere else. */
    expect(lookup).toContain('from "../../../db/schema"');
    expect(lookup).toContain("glParties.displayName");

    const selected = [...lookup.matchAll(/^\s{2}\w+: (\w+)\./gm)].map((m) => m[1]);
    expect(selected.length).toBeGreaterThan(5);
    expect(new Set(selected)).toEqual(new Set(["glParties"]));
  });

  it("keeps create-on-miss out of the posting path", () => {
    /*
      `PartiesService.resolveOrCreateByExternalRef` exists and is right for its
      one caller — the parties controller, where somebody is deliberately
      importing a counterparty. On a posting path it would turn every typo'd
      external reference into a new customer, and the duplicates would surface
      at the first aged-receivables run rather than at the point of the typo.

      Enumerated, so a second caller has to come here and argue for itself.
    */
    /* `ap/lib/ap-document-post.ts` is AP's posting path since the service was split. */
    const callers = [
      "ar/ar-documents.service.ts",
      "ap/ap-documents.service.ts",
      "ap/lib/ap-document-post.ts",
      "adapters/posting-command.service.ts",
    ];
    for (const caller of callers) {
      const source = readFileSync(join(__dirname, "..", caller), "utf8");
      expect(source).not.toContain("resolveOrCreateByExternalRef");
    }
  });

  it("never creates a party as a side effect of resolving one", () => {
    /*
      A resolver that inserted on miss would turn every typo'd external ref into
      a new customer, and the duplicates would be discovered at the first aged
      receivables run. It returns null and lets the caller decide.
    */
    const adapter = readFileSync(
      join(__dirname, "../adapters/posting-command.service.ts"),
      "utf8",
    );
    const resolver = adapter.slice(adapter.indexOf("private async resolvePartyByExternalRef"));
    const body = resolver.slice(0, resolver.indexOf("\n  }"));
    expect(body).not.toContain(".insert(");
    expect(body).toContain("return row?.id ?? null");
  });
});
