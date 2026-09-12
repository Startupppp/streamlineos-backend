import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(__dirname, "../../..");
const SCHEMA_ROOT = join(ROOT, "db/schema");
const COMPAT_MODULES = ["modules/leads", "modules/clients", "modules/contacts"].map((path) =>
  join(ROOT, path),
);

const LEGACY_DECLARATIONS = [
  { symbol: "leads", table: "leads" },
  { symbol: "clients", table: "clients" },
  { symbol: "contacts", table: "contacts" },
  { symbol: "crmOrganizations", table: "crm_organizations" },
] as const;

const LEGACY_SYMBOLS = new Set<string>(LEGACY_DECLARATIONS.map((item) => item.symbol));

function tsFilesUnder(path: string): string[] {
  if (!existsSync(path)) return [];

  const entries = readdirSync(path)
    .filter((entry) => !entry.endsWith(".map"))
    .map((entry) => join(path, entry));

  return entries.flatMap((entry) => {
    const stats = statSync(entry);
    if (stats.isDirectory()) return tsFilesUnder(entry);
    return entry.endsWith(".ts") ? [entry] : [];
  });
}

function importedNamesFromDbSchema(source: string): string[] {
  const imports = source.matchAll(/import\s+\{([\s\S]*?)\}\s+from\s+["'](?:\.\.\/)+db\/schema(?:\/index)?["'];/g);

  return [...imports].flatMap((match) =>
    match[1]
      .split(",")
      .map((name) => name.trim().split(/\s+as\s+/i)[0]?.trim())
      .filter((name): name is string => Boolean(name)),
  );
}

describe("legacy CRM identity collapse", () => {
  it("does not redeclare the dropped identity tables in the Drizzle schema", () => {
    const schemaFiles = tsFilesUnder(SCHEMA_ROOT);
    const violations: string[] = [];

    for (const file of schemaFiles) {
      const source = readFileSync(file, "utf8");

      for (const { symbol, table } of LEGACY_DECLARATIONS) {
        const declaration = new RegExp(
          `export\\s+const\\s+${symbol}\\s*=\\s*pgTable\\(\\s*["']${table}["']`,
        );
        if (declaration.test(source)) {
          violations.push(`${relative(ROOT, file)} declares ${symbol}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("keeps leads, clients and contacts compatibility modules on party/map tables", () => {
    const files = COMPAT_MODULES.flatMap(tsFilesUnder);
    const violations: string[] = [];

    for (const file of files) {
      const source = readFileSync(file, "utf8");
      const importedLegacySymbols = importedNamesFromDbSchema(source).filter((name) =>
        LEGACY_SYMBOLS.has(name),
      );

      if (importedLegacySymbols.length > 0) {
        violations.push(`${relative(ROOT, file)} imports ${importedLegacySymbols.join(", ")}`);
      }
    }

    expect(violations).toEqual([]);
  });
});
